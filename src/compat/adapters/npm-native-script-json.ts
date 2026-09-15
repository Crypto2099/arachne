import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { installNpmPackage, runDriverBatch } from './npm-install.js';

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
 */
export const NPM_NATIVE_SCRIPT_JSON_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    const pkg = requirePackage(tool);
    const exportName = requireString(tool, 'exportName');
    const slotEncoding = optionalSlotEncoding(tool);

    const installed = await installNpmPackage(pkg, version, scratchDir);
    if (installed.status === 'failed') return { status: 'failed', error: installed.error };

    const driverPath = join(scratchDir, 'driver.mjs');
    await writeFile(driverPath, driverSource(pkg, exportName, slotEncoding), 'utf8');

    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runBatch(driverPath, scratchDir, items),
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
        ? { status: 'ok', hash: entry.hash }
        : { status: 'refused', error: entry.error },
    );
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
