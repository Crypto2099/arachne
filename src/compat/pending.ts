import { existsSync } from 'node:fs';
import type { Channel, ConstructionPath, ToolsRegistry } from './types.js';
import { resolveVersions } from './versions.js';
import { DEFAULT_RESULTS_DIR, resultPath } from './results.js';

export interface PendingItem {
  tool: string;
  version: string;
  channel: Channel;
  path: ConstructionPath;
}

/**
 * Every (tool, channel, path) whose currently-resolved version has no result
 * file yet. A tool runs on `['construct']` unless it declares more, so this is
 * the whole of what "new" means to the watcher: a version already recorded,
 * on any channel, on a path it is meant to run, is not run again.
 */
export async function resolvePendingWork(
  registry: ToolsRegistry,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<PendingItem[]> {
  const pending: PendingItem[] = [];
  for (const tool of registry.tools) {
    const resolved = await resolveVersions(tool);
    const paths = tool.paths ?? ['construct'];
    for (const r of resolved) {
      for (const path of paths) {
        if (!existsSync(resultPath(tool.id, r.version, resultsDir, path))) {
          pending.push({ tool: tool.id, version: r.version, channel: r.channel, path });
        }
      }
    }
  }
  return pending;
}
