import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { installNpmPackage, runDriverBatch } from './npm-install.js';

const DRIVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'csl-driver.mjs');

/**
 * Adapter for cardano-serialization-lib's Rust/WASM Node bindings. The
 * builder API (`NativeScript.new_script_all`, `ScriptNOfK.new`, ...) is
 * specific to CSL and its forks, so a fourth tool sharing this exact API
 * (a CSL fork under a different package name) is a `compat/tools.json` entry
 * with `adapter: "npm-csl"` and its own `package`, not new code; a tool with
 * a materially different construction API needs its own adapter.
 */
export const NPM_CSL_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
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

  const result = runDriverBatch(driverPath, inputPath);
  const outcomes = new Map<string, HashOutcome>();
  if (result.status === 'failed') {
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
