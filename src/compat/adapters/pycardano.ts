import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DecodeItem,
  DecodeOutcome,
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'pycardano-driver.py');

/**
 * PyCardano (github.com/Python-Cardano/pycardano), an independent Python
 * implementation with its own encoder: `engine: { id: "pycardano", relation:
 * "own" }`. It builds native scripts as plain Python lists
 * (`pycardano/nativescript.py`'s `_script_json_to_primitive`) and serializes
 * them with `cbor2`, a general-purpose CBOR library with no size-dependent
 * indefinite-length branch of its own; `dumps` on a Python list always writes
 * a definite-length array header, so `construct` always answers `definite`.
 *
 * Registered against both construction paths, but unlike gouroboros and
 * pallas, `decode` is NOT expected to be framing-preserving here:
 * `NativeScript.hash()` always calls `self.to_cbor()`, which re-serializes
 * the decoded dataclass rather than hashing the bytes that were actually
 * read, so decoding cardanoBinary-framed CBOR and hashing the result still
 * returns the definite hash. See pycardano-driver.py for the full account;
 * this is recorded rather than skipped because the re-encoding itself is the
 * finding.
 *
 * `python3` is assumed to already be on PATH the way the npm adapters assume
 * npm is; this does not install a Python toolchain. Every install goes into
 * a venv created fresh under `scratchDir`, and `PIP_CACHE_DIR` is pointed at
 * `scratchDir` too, so nothing here touches the machine's own pip cache or
 * any globally installed package.
 *
 * pycardano's published package metadata declares `cbor2 = ">=5.6.5"` and
 * `cbor2pure = ">=5.7.2"` with no upper bound on either, so an unpinned
 * `pip install pycardano` can resolve a `cbor2` newer than pycardano and
 * `cbor2pure` have actually been tested against; at the time this adapter was
 * written, resolving `cbor2` 6.1.4 that way breaks pycardano's own import
 * (`cbor2pure` 5.8.0 still imports `CBORDecodeValueError`, which `cbor2` 6.x
 * removed). pycardano's own `poetry.lock`, committed at every tagged release,
 * records which exact `cbor2`/`cbor2pure` pair that release actually shipped
 * and was tested against, so this adapter reads that file's pins for the
 * version under test and installs exactly those alongside it, rather than
 * guessing a compatible range or leaving the incompatibility to surface as a
 * spurious "failed" result that is really about a dependency's own metadata
 * rather than about pycardano's native-script encoding. When the lock file
 * cannot be fetched, install falls back to the unpinned declaration, and
 * whatever happens next is recorded as-is.
 */
export const PYCARDANO_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    try {
      execFileSync('python3', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return {
        status: 'failed',
        error:
          e.code === 'ENOENT'
            ? 'python3 is not installed (no "python3" binary on PATH)'
            : tidyToolMessage(e.message ?? 'python3 is not installed'),
      };
    }

    await mkdir(scratchDir, { recursive: true });
    const venvDir = join(scratchDir, 'venv');
    try {
      execFileSync('python3', ['-m', 'venv', venvDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    } catch (error) {
      return { status: 'failed', error: extractPipError(error, 'python3 -m venv') };
    }

    const pip = join(venvDir, 'bin', 'pip');
    const python = join(venvDir, 'bin', 'python');
    const pipEnv = { ...process.env, PIP_CACHE_DIR: join(scratchDir, 'pip-cache') };

    const pins = await resolveKnownGoodCborPins(tool, version);
    const packages = [
      ...(pins.cbor2 ? [`cbor2==${pins.cbor2}`] : []),
      ...(pins.cbor2pure ? [`cbor2pure==${pins.cbor2pure}`] : []),
      `pycardano==${version}`,
    ];
    try {
      execFileSync(
        pip,
        ['install', '--no-input', '--disable-pip-version-check', '--quiet', ...packages],
        { env: pipEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
      );
    } catch (error) {
      return { status: 'failed', error: extractPipError(error, `pip install for ${version}`) };
    }

    // No compile step exists to catch a broken install the way "cargo build"
    // or "go build" would, so this plays that role: it is what actually
    // caught the cbor2/cbor2pure mismatch above during this adapter's own
    // development, before the pins existed.
    try {
      execFileSync(python, ['-c', 'import pycardano.nativescript'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (error) {
      return { status: 'failed', error: extractPipError(error, `import pycardano for ${version}`) };
    }

    const driverPath = join(scratchDir, 'pycardano-driver.py');
    await copyFile(DRIVER_SOURCE, driverPath);

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) =>
          runConstruct(python, driverPath, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) =>
          runDecode(python, driverPath, scratchDir, items),
        // pycardano IS its own engine, and the registry always names an exact
        // release rather than a range, so this reads the version actually
        // installed in the venv rather than echoing the one requested.
        resolveEngineVersion: async () => resolveInstalledPycardanoVersion(python),
        dispose: () => {},
      },
    };
  },
};

interface PyResult {
  id: string;
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

/**
 * Every other adapter in this package runs the whole corpus through one
 * driver invocation, the way csl-driver.mjs and gouroboros-driver.go do. This
 * one cannot: `NativeScript.from_dict`/`.hash()` goes through pycardano's
 * `typeguard`-checked dataclasses, and re-validating the recursive
 * `Union[ScriptPubkey, ScriptAll, ScriptAny, ScriptNofK, InvalidBefore,
 * InvalidHereAfter]` those fields carry gets catastrophically slower as
 * nesting gets deeper. Confirmed directly: `nest-linear` and `nest-alternating`
 * finish in about a second at depth 8, and at depth 12 do not finish inside
 * 40 seconds, versus depth 64 scripts elsewhere in the corpus (`federation`,
 * `breadth`) that stay near a second because they are wide rather than deep.
 * One slow driver call for the whole batch would make that single finding
 * cost every other vector's real answer, since a batch timeout has no way to
 * say which item inside it was the slow one. Running one process per vector,
 * each with its own bounded timeout, is what keeps a pathologically deep
 * vector a `refused` entry for itself alone rather than for the whole result.
 */
const PYCARDANO_PER_VECTOR_TIMEOUT_MS = 15_000;

async function runConstruct(
  python: string,
  driverPath: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'construct-item.json');
  const outcomes = new Map<string, HashOutcome>();
  for (const item of items) {
    await writeFile(inputPath, JSON.stringify([item]), 'utf8');
    try {
      const stdout = execFileSync(python, [driverPath, 'construct', inputPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PYCARDANO_PER_VECTOR_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      const [entry] = JSON.parse(stdout) as PyResult[];
      outcomes.set(item.id, toHashOutcome(entry?.status, entry?.hash, entry?.error));
    } catch (error) {
      outcomes.set(item.id, { status: 'refused', error: driverErrorText(error) });
    }
  }
  return outcomes;
}

interface PyDecodeResult {
  id: string;
  definite: PyHashOutcome;
  cardanoBinary: PyHashOutcome;
}

interface PyHashOutcome {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

async function runDecode(
  python: string,
  driverPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-item.json');
  const outcomes = new Map<string, DecodeOutcome>();
  for (const item of items) {
    await writeFile(inputPath, JSON.stringify([item]), 'utf8');
    try {
      const stdout = execFileSync(python, [driverPath, 'decode', inputPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PYCARDANO_PER_VECTOR_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      const [entry] = JSON.parse(stdout) as PyDecodeResult[];
      outcomes.set(item.id, {
        definite: toHashOutcome(
          entry?.definite.status,
          entry?.definite.hash,
          entry?.definite.error,
        ),
        cardanoBinary: toHashOutcome(
          entry?.cardanoBinary.status,
          entry?.cardanoBinary.hash,
          entry?.cardanoBinary.error,
        ),
      });
    } catch (error) {
      const refused: HashOutcome = { status: 'refused', error: driverErrorText(error) };
      outcomes.set(item.id, { definite: refused, cardanoBinary: refused });
    }
  }
  return outcomes;
}

function toHashOutcome(
  status: 'ok' | 'error' | undefined,
  hash: string | undefined,
  error: string | undefined,
): HashOutcome {
  if (status !== 'ok' || !hash || !isScriptHash(hash)) {
    return {
      status: 'refused',
      error: tidyToolMessage(
        error ||
          (hash
            ? `returned ${JSON.stringify(hash)}, not a 28-byte hash`
            : 'driver produced no outcome for this vector'),
      ),
    };
  }
  return { status: 'ok', hash };
}

function driverErrorText(error: unknown): string {
  const e = error as {
    code?: string;
    signal?: string;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
    message?: string;
  };
  // execFileSync has no "killed" property on the error it throws (that is
  // only on the callback-style child_process API); what it sets when its own
  // "timeout" option fires is "code: 'ETIMEDOUT'" alongside "signal:
  // 'SIGTERM'", confirmed directly against this Node version rather than
  // assumed. Naming that explicitly, rather than falling through to the
  // generic "spawnSync ... ETIMEDOUT" message, is what makes a vector deep
  // enough to hit the cost described on PYCARDANO_PER_VECTOR_TIMEOUT_MS
  // distinct from an actual crash or a real refusal in the result file.
  if (e.code === 'ETIMEDOUT') {
    return `timed out after ${PYCARDANO_PER_VECTOR_TIMEOUT_MS}ms`;
  }
  const text = (
    e.stderr?.toString() ||
    e.stdout?.toString() ||
    e.message ||
    'unknown driver failure'
  )
    .toString()
    .trim();
  return tidyToolMessage(text);
}

function extractPipError(error: unknown, context: string): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = (e.stderr?.toString() || e.stdout?.toString() || e.message || 'unknown pip failure')
    .toString()
    .trim();
  return `${context}: ${text}`.slice(0, 500);
}

async function resolveInstalledPycardanoVersion(
  python: string,
): Promise<{ version: string | null; note?: string }> {
  try {
    const stdout = execFileSync(
      python,
      ['-c', 'import importlib.metadata as m; print(m.version("pycardano"))'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    const version = stdout.trim();
    if (!version) return { version: null, note: 'importlib.metadata reported an empty version' };
    return { version };
  } catch (error) {
    return {
      version: null,
      note: `could not read the installed pycardano version: ${extractPipError(error, 'importlib.metadata')}`,
    };
  }
}

/**
 * Reads `cbor2`/`cbor2pure` pins for this exact pycardano release from its
 * own `poetry.lock`, committed alongside every tagged release, rather than
 * trusting the unbounded ranges pycardano's published package metadata
 * declares (see this module's doc comment for why those two disagree).
 * Best-effort: a network failure or an unrecognized lock format returns no
 * pins, and installation falls back to the plain declared range.
 */
async function resolveKnownGoodCborPins(
  tool: ToolDefinition,
  version: string,
): Promise<{ cbor2?: string; cbor2pure?: string }> {
  if (tool.discovery.type !== 'github-releases') return {};
  const url = `https://raw.githubusercontent.com/${tool.discovery.repo}/${tool.discovery.tagPrefix}${version}/poetry.lock`;
  try {
    const response = await fetch(url);
    if (!response.ok) return {};
    const lockText = await response.text();
    const cbor2 = lockPinFor('cbor2', lockText);
    const cbor2pure = lockPinFor('cbor2pure', lockText);
    return {
      ...(cbor2 === undefined ? {} : { cbor2 }),
      ...(cbor2pure === undefined ? {} : { cbor2pure }),
    };
  } catch {
    return {};
  }
}

function lockPinFor(pkg: string, lockText: string): string | undefined {
  const match = new RegExp(`name = "${pkg}"\\r?\\nversion = "([^"]+)"`).exec(lockText);
  return match?.[1];
}
