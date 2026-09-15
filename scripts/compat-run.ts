#!/usr/bin/env node
// Runs one tool version over the committed corpus and writes its result file.
// This is what the workflow calls once per pending item, and what a
// contributor runs by hand while adding a tool:
//
//   npx tsx scripts/compat-run.ts cardano-cli 11.2.3.1 current
//
// Human-readable progress goes to stderr; the single line of machine output
// (the written path plus the change report against the previous version) goes
// to stdout.
import { arachneVersion } from '../src/compat/arachne-version.js';
import type { Channel } from '../src/compat/types.js';
import { runCompatCheck } from '../src/compat/runner.js';
import { previousResult, writeCompatResult } from '../src/compat/results.js';
import { compareResults } from '../src/compat/change.js';

const CHANNELS: Channel[] = ['current', 'previous', 'beta'];

async function main(argv: string[]): Promise<number> {
  const [toolId, version, channelArg] = argv;
  if (!toolId || !version || !channelArg) {
    console.error('usage: compat-run.ts <toolId> <version> <current|previous|beta>');
    return 1;
  }
  if (!CHANNELS.includes(channelArg as Channel)) {
    console.error(`channel must be one of ${CHANNELS.join(', ')}, got "${channelArg}"`);
    return 1;
  }
  const channel = channelArg as Channel;

  console.error(`installing ${toolId} ${version}...`);
  const result = await runCompatCheck({
    toolId,
    version,
    channel,
    arachneVersion: await arachneVersion(),
  });

  if (result.status === 'untested') {
    console.error(`${toolId} ${version}: could not be installed`);
    console.error(`  ${result.reason}`);
  } else {
    console.error(
      `${toolId} ${version}: ${result.summary.agreed} agreed, ${result.summary.diverged} diverged, ` +
        `${result.summary.refused} refused, ${result.summary.unsupported} unsupported (framing: ${result.framing})`,
    );
  }

  const previous = await previousResult(toolId, version);
  const change = compareResults(result, previous);
  console.error(change.headline);
  for (const detail of change.details) console.error(`  ${detail}`);

  const path = await writeCompatResult(result);
  console.error(`wrote ${path}`);

  console.log(
    JSON.stringify({
      tool: toolId,
      version,
      channel,
      path,
      status: result.status,
      framing: result.framing,
      change,
    }),
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
