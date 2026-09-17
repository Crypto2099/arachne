#!/usr/bin/env node
// Regenerates compat/aggregate.json from compat/tools.json and every file
// under compat/results/. This is the one document an external consumer
// fetches instead of walking the results directory and parsing every file
// (compat/README.md, "Rendering a page from this").
//
//   npx tsx scripts/compat-aggregate.ts            write compat/aggregate.json
//   npx tsx scripts/compat-aggregate.ts --check     fail if the committed file is stale
//
// --check is what CI and "npm run verify" run: it never writes, so a
// hand-edited aggregate, or one left behind after a result file changed,
// fails the build the same way a hand-edited vector does.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  buildAggregate,
  serializeAggregate,
  DEFAULT_AGGREGATE_PATH,
} from '../src/compat/aggregate.js';

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');
  const aggregate = await buildAggregate();
  const serialized = serializeAggregate(aggregate);
  const toolCount = aggregate.tools.length;
  const resultCount = aggregate.tools.reduce((n, t) => n + t.results.length, 0);

  if (check) {
    if (!existsSync(DEFAULT_AGGREGATE_PATH)) {
      console.error(
        `${DEFAULT_AGGREGATE_PATH} does not exist. Run "npm run compat:aggregate" first.`,
      );
      return 1;
    }
    const onDisk = await readFile(DEFAULT_AGGREGATE_PATH, 'utf8');
    if (onDisk === serialized) {
      console.error(
        `${DEFAULT_AGGREGATE_PATH} matches compat/tools.json and compat/results/ (${toolCount} tools, ${resultCount} results)`,
      );
      return 0;
    }
    console.error(
      `${DEFAULT_AGGREGATE_PATH} does not match what compat/tools.json and compat/results/ produce.`,
    );
    console.error('Run "npm run compat:aggregate" and commit the result.');
    return 1;
  }

  await writeFile(DEFAULT_AGGREGATE_PATH, serialized, 'utf8');
  console.error(`wrote ${DEFAULT_AGGREGATE_PATH}: ${toolCount} tools, ${resultCount} results`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
