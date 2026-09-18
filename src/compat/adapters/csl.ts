import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DecodeItem,
  DecodeOutcome,
  InstallContext,
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { driverEntryToHashOutcome, isScriptHash, tidyToolMessage } from './hash-shape.js';
import { installNpmPackage, resolveInstalledVersion, runDriverBatch } from './npm-install.js';

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'csl-driver.mjs');

/**
 * Adapter for cardano-serialization-lib's Rust/WASM Node bindings. The
 * builder API (`NativeScript.new_script_all`, `ScriptNOfK.new`, ...) is
 * specific to CSL and its forks, so a fourth tool sharing this exact API
 * (a CSL fork under a different package name) is a `compat/tools.json` entry
 * with `adapter: "npm-csl"` and its own `package`, not new code; a tool with
 * a materially different construction API needs its own adapter.
 *
 * Also registered against `paths: ["construct", "decode"]`. `decode` calls
 * `NativeScript.from_bytes` on the corpus's own CBOR and hashes the result,
 * once per encoding; confirmed by running csl-driver.mjs's decode mode
 * against an `encoding-boundary` vector before this was wired up here that
 * CSL normalizes both encodings to `definite` on the way back out, rather
 * than reproducing whichever framing it was handed the way gouroboros does.
 */
export const NPM_CSL_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
    context?: InstallContext,
  ): Promise<InstallOutcome> {
    if (!tool.package) throw new Error(`tool "${tool.id}" has no "package"`);

    const installed = await installNpmPackage(tool.package, version, scratchDir);
    if (installed.status === 'failed') return { status: 'failed', error: installed.error };

    const driverPath = join(scratchDir, 'csl-driver.mjs');
    await copyFile(DRIVER_SOURCE, driverPath);

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runBatch(driverPath, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) => runDecodeBatch(driverPath, scratchDir, items),
        // This tool IS its engine, so the resolved version is the installed
        // package. Read from disk anyway rather than echoing the requested
        // version back, since npm is what decides what landed.
        resolveEngineVersion: async () =>
          resolveInstalledVersion(context?.enginePackage ?? tool.package!, scratchDir),
        dispose: () => {},
      },
    };
  },
};

async function runBatch(
  driverPath: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch(driverPath, inputPath, ['construct']);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: result.error });
    return outcomes;
  }
  for (const entry of result.entries) {
    outcomes.set(
      entry.id,
      entry.status === 'ok'
        ? isScriptHash(entry.hash)
          ? { status: 'ok', hash: entry.hash }
          : {
              status: 'refused',
              error: tidyToolMessage(
                `returned ${JSON.stringify(entry.hash)}, which is not a 28-byte hash`,
              ),
            }
        : { status: 'refused', error: entry.error },
    );
  }
  return outcomes;
}

interface CslDriverHashEntry {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

interface CslDriverDecodeEntry {
  id: string;
  definite: CslDriverHashEntry;
  cardanoBinary: CslDriverHashEntry;
}

async function runDecodeBatch(
  driverPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch<CslDriverDecodeEntry>(driverPath, inputPath, ['decode']);
  const outcomes = new Map<string, DecodeOutcome>();
  if (result.status === 'failed') {
    const refused: HashOutcome = { status: 'refused', error: result.error };
    for (const item of items) outcomes.set(item.id, { definite: refused, cardanoBinary: refused });
    return outcomes;
  }
  for (const entry of result.entries) {
    outcomes.set(entry.id, {
      definite: driverEntryToHashOutcome(entry.definite),
      cardanoBinary: driverEntryToHashOutcome(entry.cardanoBinary),
    });
  }
  return outcomes;
}
