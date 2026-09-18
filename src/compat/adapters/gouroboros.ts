import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DecodeItem,
  DecodeOutcome,
  HashOutcome,
  InstallOutcome,
  ObservedItem,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'gouroboros-driver.go');

/**
 * gouroboros (github.com/blinklabs-io/gouroboros), a Go implementation with
 * its own encoder: `engine: { id: "gouroboros", relation: "own" }`.
 *
 * The only adapter registered against both construction paths, because
 * gouroboros answers them differently: `common.NativeScript.Hash()` hashes
 * whatever bytes it decoded, so feeding it existing CBOR reproduces whichever
 * framing that CBOR already used, while building the same script from Go
 * structs and marshaling always yields `definite`. Neither run alone would
 * show that one library can occupy two framing categories depending on which
 * of its own APIs is used.
 *
 * `go` is assumed to already be on PATH the way the npm adapters assume npm
 * is; this does not install a Go toolchain, it installs exactly
 * `gouroboros@version` into an isolated module cache under `scratchDir` and
 * lets the Go tool itself pick whatever toolchain that version's own go.mod
 * requires (`GOTOOLCHAIN=auto` is the default and is left alone here).
 */
export const GOUROBOROS_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    try {
      execFileSync('go', ['version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return {
        status: 'failed',
        error:
          e.code === 'ENOENT'
            ? 'go is not installed (no "go" binary on PATH)'
            : tidyToolMessage(e.message ?? 'go is not installed'),
      };
    }

    await mkdir(scratchDir, { recursive: true });
    // Only the module declaration and gouroboros itself are pinned; every
    // transitive dependency and the toolchain version are resolved by "go mod
    // tidy" below, which is what lets one adapter follow gouroboros across
    // releases without this file knowing its dependency graph.
    //
    // The registry strips the release tag's leading "v" (tools.json's
    // tagPrefix) so `version` sorts as a plain numeric version the same way
    // every other tool's does; Go's own module syntax requires that "v" back,
    // so it is added here rather than carried through the rest of this
    // package.
    await writeFile(
      join(scratchDir, 'go.mod'),
      `module arachnecompatgouroboros\n\ngo 1.23\n\nrequire github.com/blinklabs-io/gouroboros ${toGoModuleVersion(version)}\n`,
      'utf8',
    );
    await copyFile(DRIVER_SOURCE, join(scratchDir, 'main.go'));

    const goEnv = {
      ...process.env,
      GOPATH: join(scratchDir, 'gopath'),
      GOCACHE: join(scratchDir, 'gocache'),
      GOFLAGS: '-mod=mod',
    };

    try {
      execFileSync('go', ['mod', 'tidy'], {
        cwd: scratchDir,
        env: goEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (error) {
      return { status: 'failed', error: extractGoError(error, `go mod tidy for ${version}`) };
    }

    const binaryPath = join(scratchDir, 'gouroboros-driver');
    try {
      execFileSync('go', ['build', '-o', binaryPath, '.'], {
        cwd: scratchDir,
        env: goEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (error) {
      return { status: 'failed', error: extractGoError(error, `go build for ${version}`) };
    }

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runConstruct(binaryPath, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) => runDecode(binaryPath, scratchDir, items),
        hashObservedScripts: async (items: ObservedItem[]) =>
          runOnchain(binaryPath, scratchDir, items),
        // gouroboros IS its own engine, and the registry always names an exact
        // release rather than a range, so this reads the version go.mod
        // actually settled on rather than echoing the one requested.
        resolveEngineVersion: async () => resolveInstalledGouroborosVersion(scratchDir),
        // "go mod download" marks every extracted module directory read-only
        // (dr-xr-xr-x), which is correct so nothing edits a cached copy in
        // place, but it also means the caller's plain "rm -rf" on scratchDir
        // fails with EACCES once this returns. Restoring write permission
        // first is this adapter's job, since it is the one that knows the
        // module cache lives under here.
        dispose: () => {
          try {
            execFileSync('chmod', ['-R', 'u+w', join(scratchDir, 'gopath')], {
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30_000,
            });
          } catch {
            // Best-effort: if this fails, cleanup below may leave scratch
            // files behind, which costs disk, not correctness.
          }
        },
      },
    };
  },
};

interface GoConstructResult {
  id: string;
  status: 'ok' | 'unsupported' | 'error';
  hash?: string;
  error?: string;
}

async function runConstruct(
  binaryPath: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'construct-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, HashOutcome>();
  let entries: GoConstructResult[];
  try {
    const stdout = execFileSync(binaryPath, ['construct', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as GoConstructResult[];
  } catch (error) {
    const text = driverErrorText(error);
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: text });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, toHashOutcome(entry.status, entry.hash, entry.error));
  }
  return outcomes;
}

interface GoHashOutcome {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

interface GoDecodeResult {
  id: string;
  definite: GoHashOutcome;
  cardanoBinary: GoHashOutcome;
}

async function runDecode(
  binaryPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, DecodeOutcome>();
  let entries: GoDecodeResult[];
  try {
    const stdout = execFileSync(binaryPath, ['decode', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as GoDecodeResult[];
  } catch (error) {
    const text = driverErrorText(error);
    const refused: HashOutcome = { status: 'refused', error: text };
    for (const item of items) outcomes.set(item.id, { definite: refused, cardanoBinary: refused });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, {
      definite: toHashOutcome(entry.definite.status, entry.definite.hash, entry.definite.error),
      cardanoBinary: toHashOutcome(
        entry.cardanoBinary.status,
        entry.cardanoBinary.hash,
        entry.cardanoBinary.error,
      ),
    });
  }
  return outcomes;
}

/**
 * The observed-bytes path. The driver answers it in the same flat shape the
 * construct path uses, one outcome per item, because an observed script has
 * one framing and so one question.
 */
async function runOnchain(
  binaryPath: string,
  scratchDir: string,
  items: ObservedItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'onchain-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, HashOutcome>();
  let entries: GoConstructResult[];
  try {
    const stdout = execFileSync(binaryPath, ['onchain', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as GoConstructResult[];
  } catch (error) {
    const text = driverErrorText(error);
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: text });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, toHashOutcome(entry.status, entry.hash, entry.error));
  }
  return outcomes;
}

/**
 * Maps the driver's three-way status onto `HashOutcome`. "unsupported" only
 * ever comes from the construct path recognizing a construct as unrepresentable
 * ahead of calling gouroboros at all (the negative-threshold case); "error" is
 * gouroboros's or the CBOR decoder's own response to an attempt that was
 * actually made, which is a refusal rather than a recognized-in-advance gap.
 */
function toHashOutcome(
  status: 'ok' | 'unsupported' | 'error',
  hash: string | undefined,
  error: string | undefined,
): HashOutcome {
  if (status === 'unsupported') {
    return { status: 'unsupported', error: tidyToolMessage(error ?? 'unsupported') };
  }
  if (status === 'error' || !hash || !isScriptHash(hash)) {
    return {
      status: 'refused',
      error: tidyToolMessage(
        error || (hash ? `returned ${JSON.stringify(hash)}, not a 28-byte hash` : 'no hash'),
      ),
    };
  }
  return { status: 'ok', hash };
}

function driverErrorText(error: unknown): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
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

function extractGoError(error: unknown, context: string): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = (e.stderr?.toString() || e.stdout?.toString() || e.message || 'unknown go failure')
    .toString()
    .trim();
  return `${context}: ${text}`.slice(0, 500);
}

/** Go module versions are always "v"-prefixed; this project's own version strings never are. */
function toGoModuleVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * The gouroboros version actually recorded in the scratch install's go.mod
 * after "go mod tidy" resolved it, read from disk rather than echoing the
 * version this adapter requested, with the "v" Go's module syntax requires
 * stripped back off so it matches this result's own `version` field.
 */
async function resolveInstalledGouroborosVersion(
  scratchDir: string,
): Promise<{ version: string | null; note?: string }> {
  try {
    const goMod = await readFile(join(scratchDir, 'go.mod'), 'utf8');
    const match = /^require github\.com\/blinklabs-io\/gouroboros (\S+)$/m.exec(goMod);
    const resolved = match?.[1];
    if (!resolved) {
      return {
        version: null,
        note: 'go.mod has no require line for github.com/blinklabs-io/gouroboros',
      };
    }
    return { version: resolved.startsWith('v') ? resolved.slice(1) : resolved };
  } catch (error) {
    return {
      version: null,
      note: `could not read go.mod: ${(error as Error).message}`,
    };
  }
}
