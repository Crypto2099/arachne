import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DecodeItem,
  DecodeOutcome,
  HashOutcome,
  InstallContext,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { driverEntryToHashOutcome, isScriptHash, tidyToolMessage } from './hash-shape.js';
import { installNpmPackage, resolveInstalledVersion, runDriverBatch } from './npm-install.js';

/**
 * Adapter kind for a library that exposes a single function taking the
 * plain-JSON native script shape (`{ type, keyHash | scripts | required |
 * slot }`, the same tags this project's own model uses) and returning a hex
 * script hash. MeshJS's `resolveNativeScriptHash` is the first example; a
 * fourth tool with the same shape of API is a `compat/tools.json` entry
 * naming its package and export, not a new adapter.
 *
 * `adapterOptions.slotEncoding` exists because MeshJS's `NativeScript` type
 * carries `slot` as a decimal string rather than a number; a future tool with
 * the same function shape but a numeric slot sets it to `"number"` and needs
 * no code change either.
 *
 * `adapterOptions.decodeExportName`, when present, names a second exported
 * function of the same shape as MeshJS's `resolveScriptHash`: it takes a CBOR
 * hex string directly and returns a hash, with no JSON native-script shape
 * involved at all, which is what makes it a decode path rather than the
 * construct path wearing a different name. A tool entry that sets this and
 * lists `"decode"` in `paths` gets a second driver built from it; a tool with
 * no such function (or none confirmed) simply omits the option and stays on
 * `construct`, the default for this adapter before this field existed.
 */
export const NPM_NATIVE_SCRIPT_JSON_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
    context?: InstallContext,
  ): Promise<InstallOutcome> {
    const pkg = requirePackage(tool);
    const exportName = requireString(tool, 'exportName');
    const slotEncoding = optionalSlotEncoding(tool);
    const decodeExportName = optionalString(tool, 'decodeExportName');

    const installed = await installNpmPackage(pkg, version, scratchDir);
    if (installed.status === 'failed') return { status: 'failed', error: installed.error };

    const driverPath = join(scratchDir, 'driver.mjs');
    await writeFile(driverPath, driverSource(pkg, exportName, slotEncoding), 'utf8');

    let decodeDriverPath: string | undefined;
    if (decodeExportName) {
      decodeDriverPath = join(scratchDir, 'decode-driver.mjs');
      await writeFile(decodeDriverPath, decodeDriverSource(pkg, decodeExportName), 'utf8');
    }

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runBatch(driverPath, scratchDir, items),
        ...(decodeDriverPath
          ? {
              decodeScripts: async (items: DecodeItem[]) =>
                runDecodeBatch(decodeDriverPath!, scratchDir, items),
            }
          : {}),
        // The engine sits below this package, often at a version the tool pins
        // rather than the newest published, so it is read off the install.
        resolveEngineVersion: async () =>
          context?.enginePackage
            ? resolveInstalledVersion(context.enginePackage, scratchDir)
            : { version: null, note: 'no engine package declared for this tool' },
        dispose: () => {},
      },
    };
  },
};

function requirePackage(tool: ToolDefinition): string {
  if (!tool.package) throw new Error(`tool "${tool.id}" has no "package"`);
  return tool.package;
}

function requireString(tool: ToolDefinition, key: string): string {
  const value = tool.adapterOptions?.[key];
  if (typeof value !== 'string') {
    throw new Error(`tool "${tool.id}" is missing adapterOptions.${key}`);
  }
  return value;
}

function optionalString(tool: ToolDefinition, key: string): string | undefined {
  const value = tool.adapterOptions?.[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalSlotEncoding(tool: ToolDefinition): 'number' | 'string' {
  const value = tool.adapterOptions?.['slotEncoding'];
  if (value === 'string') return 'string';
  return 'number';
}

async function runBatch(
  driverPath: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch(driverPath, inputPath);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
    // The whole batch could not run at all (the export was not a function,
    // the module failed to load). Every vector gets the same verbatim text:
    // this is a fact about the tool version, not about any one script.
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

interface DecodeDriverEntry {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

interface DecodeDriverOutputEntry {
  id: string;
  definite: DecodeDriverEntry;
  cardanoBinary: DecodeDriverEntry;
}

async function runDecodeBatch(
  driverPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const result = runDriverBatch<DecodeDriverOutputEntry>(driverPath, inputPath);
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

function driverSource(pkg: string, exportName: string, slotEncoding: 'number' | 'string'): string {
  // Generated rather than a static file, because the package name and export
  // to call are data from compat/tools.json, not known until an adapter runs.
  return `import { readFileSync } from 'node:fs';

const mod = await import(${JSON.stringify(pkg)});
const resolve = mod[${JSON.stringify(exportName)}] ?? (mod.default ? mod.default[${JSON.stringify(exportName)}] : undefined);
if (typeof resolve !== 'function') {
  process.stderr.write(${JSON.stringify(`"${exportName}" is not an exported function of "${pkg}"`)});
  process.exit(1);
}

function transformSlots(node) {
  if (node.type === 'after' || node.type === 'before') {
    return { type: node.type, slot: ${slotEncoding === 'string' ? 'String(node.slot)' : 'node.slot'} };
  }
  if (node.type === 'sig') return node;
  if (node.type === 'atLeast') {
    return { type: 'atLeast', required: node.required, scripts: node.scripts.map(transformSlots) };
  }
  return { type: node.type, scripts: node.scripts.map(transformSlots) };
}

const [, , inputPath] = process.argv;
const items = JSON.parse(readFileSync(inputPath, 'utf8'));
const out = items.map(({ id, script }) => {
  try {
    const hash = resolve(transformSlots(script));
    return { id, status: 'ok', hash };
  } catch (error) {
    return { id, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
});
process.stdout.write(JSON.stringify(out));
`;
}

/**
 * A driver for the decode path: `decodeExportName` takes a CBOR hex string
 * directly (MeshJS's `resolveScriptHash(scriptCode, version?)`, called here
 * with only `scriptCode` so it takes the native-script branch) rather than
 * this project's JSON shape, so `transformSlots` above has nothing to do
 * here and is not reused.
 */
function decodeDriverSource(pkg: string, decodeExportName: string): string {
  return `import { readFileSync } from 'node:fs';

const mod = await import(${JSON.stringify(pkg)});
const resolve = mod[${JSON.stringify(decodeExportName)}] ?? (mod.default ? mod.default[${JSON.stringify(decodeExportName)}] : undefined);
if (typeof resolve !== 'function') {
  process.stderr.write(${JSON.stringify(`"${decodeExportName}" is not an exported function of "${pkg}"`)});
  process.exit(1);
}

function decodeAndHash(cborHex) {
  try {
    return { status: 'ok', hash: resolve(cborHex) };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

const [, , inputPath] = process.argv;
const items = JSON.parse(readFileSync(inputPath, 'utf8'));
const out = items.map(({ id, definiteCborHex, cardanoBinaryCborHex }) => ({
  id,
  definite: decodeAndHash(definiteCborHex),
  cardanoBinary: decodeAndHash(cardanoBinaryCborHex),
}));
process.stdout.write(JSON.stringify(out));
`;
}
