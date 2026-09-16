import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sortVersionsDescending } from './semver.js';
import type { CompatResult } from './result-schema.js';
import type { ConstructionPath } from './types.js';

export const DEFAULT_RESULTS_DIR = 'compat/results';

/**
 * One tool version can be run on more than one construction path (gouroboros
 * is, today), and each run is its own committed file rather than two answers
 * folded into one. `construct` keeps the bare `<version>.json` name every
 * tool used before a decode-path adapter existed; `decode` gets its own
 * suffixed name so the two never collide.
 */
export function resultPath(
  toolId: string,
  version: string,
  dir = DEFAULT_RESULTS_DIR,
  path: ConstructionPath = 'construct',
): string {
  const suffix = path === 'decode' ? '-decode' : '';
  return join(dir, toolId, `${version}${suffix}.json`);
}

export async function writeCompatResult(
  result: CompatResult,
  dir = DEFAULT_RESULTS_DIR,
): Promise<string> {
  const path = resultPath(result.tool, result.version, dir, result.path);
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
 * The result immediately below `version` in precedence for this tool on this
 * construction path, tested or not, so a fresh run can say what changed since
 * the last one that mattered. Excludes `version` itself, since a version can
 * be re-run, and excludes every other path, since a construct result and a
 * decode result are never a meaningful "before" and "after" of each other.
 */
export async function previousResult(
  toolId: string,
  version: string,
  dir = DEFAULT_RESULTS_DIR,
  path: ConstructionPath = 'construct',
): Promise<CompatResult | undefined> {
  const results = (await loadResultsForTool(toolId, dir)).filter(
    (r) => r.version !== version && r.path === path,
  );
  const ordered = sortVersionsDescending([version, ...results.map((r) => r.version)]);
  const position = ordered.indexOf(version);
  const nextVersion = ordered[position + 1];
  return results.find((r) => r.version === nextVersion);
}
