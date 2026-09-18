import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'pallas-driver.rs');

/**
 * pallas-primitives (github.com/txpipe/pallas), txpipe's independent Rust
 * ledger-types crate, with its own encoder: `engine: { id: "pallas",
 * relation: "own" }`. Rust is also what cardano-serialization-lib is written
 * in, but the two share nothing beyond the language: CSL is a separate
 * codebase built on its own hand-rolled CBOR writer and compiled to WASM,
 * while pallas is a native crate built on `minicbor`
 * (`pallas-codec`/src/lib.rs re-exports it "as-is" as the workspace's "single
 * source of truth for CBOR").
 *
 * Registered against both construction paths, the same reason gouroboros is:
 * `pallas_primitives::alonzo::NativeScript`'s `Encode` impl
 * (src/alonzo/native_script.rs) only ever calls minicbor's `Encoder::array`,
 * which always writes a definite-length header regardless of child count, so
 * `construct` always answers `definite`. `decode` asks a different question
 * by decoding into `pallas_codec::utils::KeepRaw<NativeScript>` instead,
 * which records the exact bytes minicbor read and re-emits them verbatim on
 * encode rather than re-serializing the decoded tree; hashing that answers
 * whichever framing it was actually fed. See pallas-driver.rs for the full
 * account of why decode needs `KeepRaw` to be a different question from
 * `construct` at all.
 *
 * `cargo` is assumed to already be on PATH the way the npm adapters assume
 * npm is; this does not install a Rust toolchain. `CARGO_HOME` and
 * `CARGO_TARGET_DIR` are pointed at `scratchDir` so the build's registry
 * cache and compiled artifacts stay isolated from the machine's own `~/.cargo`
 * rather than leaking into it.
 */
export const PALLAS_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    try {
      execFileSync('cargo', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return {
        status: 'failed',
        error:
          e.code === 'ENOENT'
            ? 'cargo is not installed (no "cargo" binary on PATH)'
            : tidyToolMessage(e.message ?? 'cargo is not installed'),
      };
    }

    await mkdir(scratchDir, { recursive: true });
    // pallas-codec and pallas-crypto are not this tool's dependency in name,
    // but the driver imports both directly (for `minicbor`/`KeepRaw` and for
    // `Hasher`, neither of which pallas-primitives re-exports), and the
    // upstream workspace always cuts all three crates at the same version
    // number (confirmed on crates.io for every channel this registry tracks:
    // 1.3.0, 1.2.0 all exist for all three), so pinning all three to exactly
    // `version` is what "the exact pallas-primitives release under test"
    // means for the driver's whole dependency graph, not a guess about a
    // crate that happens to share a number.
    await writeFile(
      join(scratchDir, 'Cargo.toml'),
      [
        '[package]',
        'name = "arachne-compat-pallas-driver"',
        'version = "0.0.0"',
        'edition = "2021"',
        'publish = false',
        '',
        '[[bin]]',
        'name = "pallas-driver"',
        'path = "main.rs"',
        '',
        '[dependencies]',
        `pallas-primitives = "=${version}"`,
        `pallas-codec = "=${version}"`,
        `pallas-crypto = "=${version}"`,
        'serde = { version = "1", features = ["derive"] }',
        // "unbounded_depth" plus serde_stacker is serde_json's own documented
        // pattern for parsing JSON deeper than its default 128-frame guard
        // without risking a real stack overflow (Deserializer's
        // disable_recursion_limit doc comment). The corpus's own
        // "nest-alternating" family reaches depth 65, which already exceeds
        // that guard once doubled by the driver's internally-tagged enum
        // buffering its input, so this is required for correctness today, not
        // future-proofing. See main.rs's parse_deep.
        'serde_json = { version = "1", features = ["unbounded_depth"] }',
        'serde_stacker = "0.1"',
        'hex = "0.4"',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(scratchDir, 'main.rs'), await readFile(DRIVER_SOURCE, 'utf8'), 'utf8');

    const cargoEnv = {
      ...process.env,
      CARGO_HOME: join(scratchDir, 'cargo-home'),
      CARGO_TARGET_DIR: join(scratchDir, 'target'),
    };

    const binaryPath = join(scratchDir, 'target', 'debug', 'pallas-driver');
    try {
      execFileSync('cargo', ['build', '--quiet'], {
        cwd: scratchDir,
        env: cargoEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (error) {
      return { status: 'failed', error: extractCargoError(error, `cargo build for ${version}`) };
    }

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runConstruct(binaryPath, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) => runDecode(binaryPath, scratchDir, items),
        hashObservedScripts: async (items: ObservedItem[]) =>
          runOnchain(binaryPath, scratchDir, items),
        // pallas IS its own engine, and the registry always names an exact
        // release rather than a range, so this reads the version Cargo.lock
        // actually settled on rather than echoing the one requested.
        resolveEngineVersion: async () => resolveInstalledPallasVersion(scratchDir),
        dispose: () => {},
      },
    };
  },
};

interface RustResult {
  id: string;
  status: 'ok' | 'error';
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
  let entries: RustResult[];
  try {
    const stdout = execFileSync(binaryPath, ['construct', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as RustResult[];
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

interface RustDecodeResult {
  id: string;
  definite: RustHashOutcome;
  cardanoBinary: RustHashOutcome;
}

interface RustHashOutcome {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

async function runDecode(
  binaryPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, DecodeOutcome>();
  let entries: RustDecodeResult[];
  try {
    const stdout = execFileSync(binaryPath, ['decode', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as RustDecodeResult[];
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
  let entries: RustResult[];
  try {
    const stdout = execFileSync(binaryPath, ['onchain', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as RustResult[];
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
 * Maps the driver's status onto `HashOutcome`. Unlike gouroboros's driver,
 * this one never reports "unsupported": `ScriptNOfK`'s threshold field is a
 * signed `i64`, so the corpus's one negative-threshold vector is representable
 * and comes back as an actual hash rather than a recognized-in-advance gap.
 */
function toHashOutcome(
  status: 'ok' | 'error',
  hash: string | undefined,
  error: string | undefined,
): HashOutcome {
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

function extractCargoError(error: unknown, context: string): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = (
    e.stderr?.toString() ||
    e.stdout?.toString() ||
    e.message ||
    'unknown cargo failure'
  )
    .toString()
    .trim();
  return `${context}: ${text}`.slice(0, 500);
}

/**
 * The pallas-primitives version actually recorded in the scratch install's
 * Cargo.lock after "cargo build" resolved it, read from disk rather than
 * echoing the version this adapter requested. The two are expected to match,
 * since Cargo.toml pins it with "=", but reading it back is what a "resolved
 * engine version" means for every other adapter in this package and there is
 * no reason for this one to assert it instead of checking it.
 */
async function resolveInstalledPallasVersion(
  scratchDir: string,
): Promise<{ version: string | null; note?: string }> {
  try {
    const cargoLock = await readFile(join(scratchDir, 'Cargo.lock'), 'utf8');
    const match = /name = "pallas-primitives"\nversion = "([^"]+)"/.exec(cargoLock);
    const resolved = match?.[1];
    if (!resolved) {
      return { version: null, note: 'Cargo.lock has no [[package]] entry for pallas-primitives' };
    }
    return { version: resolved };
  } catch (error) {
    return { version: null, note: `could not read Cargo.lock: ${(error as Error).message}` };
  }
}
