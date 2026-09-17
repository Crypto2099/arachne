import { copyFile, writeFile } from 'node:fs/promises';
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
import { installNpmPackage, resolveInstalledVersion, runDriverBatch } from './npm-install.js';

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'cml-driver.mjs');

/**
 * Adapter for cardano-multiplatform-lib's Rust/WASM Node bindings.
 * `new_script_pubkey`, `new_script_all`, `ScriptAll`/`NativeScriptList`
 * builders and `.hash().to_hex()` are CML's own names, distinct from
 * cardano-serialization-lib's (`new_script_pubkey` here takes an
 * `Ed25519KeyHash` directly rather than a `ScriptPubkey` wrapper, and the
 * threshold/slot arguments are `BigInt`, not `BigNum`), which is why this is
 * its own adapter rather than a `npm-csl` entry: the existing `npm-csl`
 * driver was tried against this package first and throws
 * "expected instance of Ed25519KeyHash" on the first `sig` script it builds.
 *
 * `cml-driver.mjs` reads the package name off `argv` rather than importing a
 * hard-coded one, because this one adapter also serves the Anastasia Labs
 * fork (`@anastasia-labs/cardano-multiplatform-lib-nodejs`), which is built
 * from the same source tree and exposes the identical constructor API. A
 * fourth CML-API-compatible package is a `compat/tools.json` entry naming
 * `adapter: "npm-cml"` and its own `package`, not new code.
 *
 * Registered against both construction paths: CML's `from_cbor_hex` keeps
 * the exact bytes it decoded and `.hash()` hashes those, so `construct`
 * (always definite-length) and `decode` (whichever framing was fed in)
 * answer the framing question differently, the same property gouroboros has.
 */
export const NPM_CML_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    if (!tool.package) throw new Error(`tool "${tool.id}" has no "package"`);
    const pkg = tool.package;

    const installed = await installNpmPackage(pkg, version, scratchDir);
    if (installed.status === 'failed') return { status: 'failed', error: installed.error };

    const driverPath = join(scratchDir, 'cml-driver.mjs');
    await copyFile(DRIVER_SOURCE, driverPath);

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) =>
          runConstruct(driverPath, pkg, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) => runDecode(driverPath, pkg, scratchDir, items),
        // Every tool on this adapter either IS the cardano-multiplatform-lib
        // engine (dcSpark's own build) or ships its own forked build of it
        // under a different package name (Anastasia Labs), so there is never
        // a separate engine package to read out of a dependency edge: the
        // installed package's own version is the fact to record, regardless
        // of what compat/tools.json's engine entry names for documentation.
        resolveEngineVersion: async () => resolveInstalledVersion(pkg, scratchDir),
        dispose: () => {},
      },
    };
  },
};

async function runConstruct(
  driverPath: string,
  pkg: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'construct-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch(driverPath, inputPath, ['construct', pkg]);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: result.error });
    return outcomes;
  }
  for (const entry of result.entries) outcomes.set(entry.id, toHashOutcome(entry));
  return outcomes;
}

interface CmlDecodeEntry {
  id: string;
  definite: { status: 'ok'; hash: string } | { status: 'error'; error: string };
  cardanoBinary: { status: 'ok'; hash: string } | { status: 'error'; error: string };
}

async function runDecode(
  driverPath: string,
  pkg: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch<CmlDecodeEntry>(driverPath, inputPath, ['decode', pkg]);
  const outcomes = new Map<string, DecodeOutcome>();
  if (result.status === 'failed') {
    const refused: HashOutcome = { status: 'refused', error: result.error };
    for (const item of items) outcomes.set(item.id, { definite: refused, cardanoBinary: refused });
    return outcomes;
  }
  for (const entry of result.entries) {
    outcomes.set(entry.id, {
      definite: toHashOutcome(entry.definite),
      cardanoBinary: toHashOutcome(entry.cardanoBinary),
    });
  }
  return outcomes;
}

function toHashOutcome(
  entry: { status: 'ok'; hash: string } | { status: 'error'; error: string },
): HashOutcome {
  if (entry.status === 'error') {
    return { status: 'refused', error: entry.error };
  }
  return isScriptHash(entry.hash)
    ? { status: 'ok', hash: entry.hash }
    : {
        status: 'refused',
        error: tidyToolMessage(
          `returned ${JSON.stringify(entry.hash)}, which is not a 28-byte hash`,
        ),
      };
}
