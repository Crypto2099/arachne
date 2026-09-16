#!/usr/bin/env node
// Resolves the current/previous/beta version of every registered tool and
// reports which ones have no result file yet. Makes no network writes and
// installs nothing, so it doubles as the workflow's dry-run mode: running
// this alone answers "what would upstream-watch do right now" without
// spending the time or the disk of an actual install.
//
// Human-readable progress goes to stderr; the single line of machine output
// (a JSON array of pending items) goes to stdout, so `tsx scripts/compat-check.ts`
// is safe to pipe.
import { loadToolRegistry } from '../src/compat/registry.js';
import { resolvePendingWork } from '../src/compat/pending.js';

async function main(): Promise<number> {
  const registry = await loadToolRegistry();
  const pending = await resolvePendingWork(registry);

  if (pending.length === 0) {
    console.error('nothing pending: every resolvable channel already has a recorded result');
  } else {
    console.error(`${pending.length} pending:`);
    for (const item of pending) {
      console.error(`  ${item.tool} ${item.version} (${item.channel}, ${item.path})`);
    }
  }

  console.log(JSON.stringify(pending));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
