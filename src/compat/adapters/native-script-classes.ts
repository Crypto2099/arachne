import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DecodeItem,
  DecodeOutcome,
  HashOutcome,
  InstallContext,
  InstallOutcome,
  ObservedItem,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';
import { installNpmPackage, resolveInstalledVersion, runDriverBatch } from './npm-install.js';

const DRIVER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  'native-script-classes-driver.mjs',
);

/**
 * Adapter for a package exposing cardano-js-sdk's `Serialization.NativeScript`
 * class shape: `NativeScript.newScriptPubkey(new ScriptPubkey(keyHash))`,
 * `newScriptAll(new ScriptAll(children))`, `newScriptNOfK(new
 * ScriptNOfK(children, required))`, `newTimelockStart`/`newTimelockExpiry`
 * taking a slot directly, and an instance `.hash()` that returns a hex string
 * rather than a wrapped hash object. `@cardano-sdk/core` exposes these under
 * a `Serialization` namespace; `@blaze-cardano/core` re-exports the identical
 * classes at its module root, not a reimplementation of them, since its own
 * source aliases `NativeScript` straight from `Serialization.NativeScript`
 * (see `compat/README.md`). `adapterOptions.namespace` is the dotted path to
 * that namespace (`"Serialization"`, or `""` for the module root), which is
 * the only thing distinguishing the two; a third package exposing this exact
 * class API is a `compat/tools.json` entry naming `adapter:
 * "npm-native-script-classes"` and its own `package`/`adapterOptions.namespace`,
 * not new code. Neither `npm-csl` nor `npm-native-script-json` fits: the
 * class and method names here match neither cardano-serialization-lib's
 * builder API nor a single-function `resolveNativeScriptHash`-style export.
 *
 * Registered against both construction paths: every class here keeps the
 * original bytes it was decoded from and returns them verbatim from
 * `toCbor()`, so `.hash()` after `fromCbor(...)` reflects the input's own
 * framing rather than re-imposing `construct`'s always-definite one.
 */
export const NPM_NATIVE_SCRIPT_CLASSES_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
    context?: InstallContext,
  ): Promise<InstallOutcome> {
    if (!tool.package) throw new Error(`tool "${tool.id}" has no "package"`);
    const pkg = tool.package;
    const namespace = optionalNamespace(tool);

    const installed = await installNpmPackage(pkg, version, scratchDir);
    if (installed.status === 'failed') return { status: 'failed', error: installed.error };

    const driverPath = join(scratchDir, 'native-script-classes-driver.mjs');
    await copyFile(DRIVER_SOURCE, driverPath);

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) =>
          runConstruct(driverPath, pkg, namespace, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) =>
          runDecode(driverPath, pkg, namespace, scratchDir, items),
        hashObservedScripts: async (items: ObservedItem[]) =>
          runOnchain(driverPath, pkg, namespace, scratchDir, items),
        // The engine sits below this package. For "@cardano-sdk/core" itself
        // that is this same package (relation "own"); for a consumer like
        // Blaze it is a separate dependency edge (relation "depends"), read
        // from what actually landed in this install's own node_modules.
        resolveEngineVersion: async () =>
          context?.enginePackage
            ? resolveInstalledVersion(context.enginePackage, scratchDir)
            : resolveInstalledVersion(pkg, scratchDir),
        dispose: () => {},
      },
    };
  },
};

function optionalNamespace(tool: ToolDefinition): string {
  const value = tool.adapterOptions?.['namespace'];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new Error(`tool "${tool.id}" has a non-string adapterOptions.namespace`);
  }
  return value;
}

async function runConstruct(
  driverPath: string,
  pkg: string,
  namespace: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'construct-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch(driverPath, inputPath, ['construct', pkg, namespace]);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: result.error });
    return outcomes;
  }
  for (const entry of result.entries) outcomes.set(entry.id, toHashOutcome(entry));
  return outcomes;
}

interface ClassesDecodeEntry {
  id: string;
  definite: { status: 'ok'; hash: string } | { status: 'error'; error: string };
  cardanoBinary: { status: 'ok'; hash: string } | { status: 'error'; error: string };
}

async function runDecode(
  driverPath: string,
  pkg: string,
  namespace: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch<ClassesDecodeEntry>(driverPath, inputPath, [
    'decode',
    pkg,
    namespace,
  ]);
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

/**
 * The observed-bytes path. The driver answers it in the same flat shape the
 * construct path uses, one outcome per item, because an observed script has
 * one framing and so one question.
 */
async function runOnchain(
  driverPath: string,
  pkg: string,
  namespace: string,
  scratchDir: string,
  items: ObservedItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'onchain-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch(driverPath, inputPath, ['onchain', pkg, namespace]);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: result.error });
    return outcomes;
  }
  for (const entry of result.entries) outcomes.set(entry.id, toHashOutcome(entry));
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
