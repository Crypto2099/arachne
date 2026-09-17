#!/usr/bin/env node
// Regenerates compat/version.json from compat/aggregate.json's committed
// bytes: a small document a consumer polls to decide whether to refetch the
// aggregate (compat/README.md, "Freshness").
//
//   npx tsx scripts/compat-version.ts            write compat/version.json
//   npx tsx scripts/compat-version.ts --check     fail if the committed file is stale
//
// Depends on compat/aggregate.json already being current on disk, the same
// way "npm run verify" runs "compat:aggregate:check" before this. --check
// never writes, so a hand-edited version.json, or one left behind after the
// aggregate changed underneath it, fails the build the same way a
// hand-edited vector does.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DEFAULT_AGGREGATE_PATH } from '../src/compat/aggregate.js';
import {
  buildVersionDocument,
  serializeVersionDocument,
  DEFAULT_VERSION_PATH,
} from '../src/compat/version.js';

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');

  if (!existsSync(DEFAULT_AGGREGATE_PATH)) {
    console.error(
      `${DEFAULT_AGGREGATE_PATH} does not exist. Run "npm run compat:aggregate" first.`,
    );
    return 1;
  }

  const doc = await buildVersionDocument(DEFAULT_AGGREGATE_PATH);
  const serialized = serializeVersionDocument(doc);

  if (check) {
    if (!existsSync(DEFAULT_VERSION_PATH)) {
      console.error(`${DEFAULT_VERSION_PATH} does not exist. Run "npm run compat:version" first.`);
      return 1;
    }
    const onDisk = await readFile(DEFAULT_VERSION_PATH, 'utf8');
    if (onDisk === serialized) {
      console.error(
        `${DEFAULT_VERSION_PATH} matches ${DEFAULT_AGGREGATE_PATH} (${doc.toolCount} tools, ${doc.resultCount} results)`,
      );
      return 0;
    }
    console.error(
      `${DEFAULT_VERSION_PATH} does not match what ${DEFAULT_AGGREGATE_PATH} produces.`,
    );
    console.error('Run "npm run compat:version" and commit the result.');
    return 1;
  }

  await writeFile(DEFAULT_VERSION_PATH, serialized, 'utf8');
  console.error(
    `wrote ${DEFAULT_VERSION_PATH}: ${doc.toolCount} tools, ${doc.resultCount} results`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
