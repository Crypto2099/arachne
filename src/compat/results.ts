import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sortVersionsDescending } from './semver.js';
import type { CompatResult } from './result-schema.js';

export const DEFAULT_RESULTS_DIR = 'compat/results';

export function resultPath(toolId: string, version: string, dir = DEFAULT_RESULTS_DIR): string {
  return join(dir, toolId, `${version}.json`);
}

export async function writeCompatResult(
  result: CompatResult,
  dir = DEFAULT_RESULTS_DIR,
): Promise<string> {
  const path = resultPath(result.tool, result.version, dir);
  await mkdir(join(dir, result.tool), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return path;
}

/** Every already-committed result for one tool, highest version first. */
export async function loadResultsForTool(
  toolId: string,
  dir = DEFAULT_RESULTS_DIR,
): Promise<CompatResult[]> {
  const toolDir = join(dir, toolId);
  if (!existsSync(toolDir)) return [];
  const files = (await readdir(toolDir)).filter((f) => f.endsWith('.json'));
  const results = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(toolDir, f), 'utf8')) as CompatResult),
  );
  const order = new Map(
    sortVersionsDescending(results.map((r) => r.version)).map((v, i) => [v, i]),
  );
  return results.sort((a, b) => (order.get(a.version) ?? 0) - (order.get(b.version) ?? 0));
}

/**
 * The result immediately below `version` in precedence for this tool, tested
 * or not, so a fresh run can say what changed since the last one that
 * mattered. Excludes `version` itself, since a version can be re-run.
 */
export async function previousResult(
  toolId: string,
  version: string,
  dir = DEFAULT_RESULTS_DIR,
): Promise<CompatResult | undefined> {
  const results = (await loadResultsForTool(toolId, dir)).filter((r) => r.version !== version);
  const ordered = sortVersionsDescending([version, ...results.map((r) => r.version)]);
  const position = ordered.indexOf(version);
  const nextVersion = ordered[position + 1];
  return results.find((r) => r.version === nextVersion);
}
