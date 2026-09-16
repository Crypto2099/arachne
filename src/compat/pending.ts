import { existsSync } from 'node:fs';
import type { Channel, ToolsRegistry } from './types.js';
import { resolveVersions } from './versions.js';
import { DEFAULT_RESULTS_DIR, resultPath } from './results.js';

export interface PendingItem {
  tool: string;
  version: string;
  channel: Channel;
}

/**
 * Every (tool, channel) whose currently-resolved version has no result file
 * yet. This is the whole of what "new" means to the watcher: a version
 * already recorded, on any channel, is not run again.
 */
export async function resolvePendingWork(
  registry: ToolsRegistry,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<PendingItem[]> {
  const pending: PendingItem[] = [];
  for (const tool of registry.tools) {
    const resolved = await resolveVersions(tool);
    for (const r of resolved) {
      if (!existsSync(resultPath(tool.id, r.version, resultsDir))) {
        pending.push({ tool: tool.id, version: r.version, channel: r.channel });
      }
    }
  }
  return pending;
}
