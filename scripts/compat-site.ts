#!/usr/bin/env node
// Builds the Pages artifact: compat/aggregate.json and compat/version.json
// (already committed, never regenerated here) plus a matrix page rendered
// from them, all written flat into one output directory so the deploy
// workflow can hand the whole thing to actions/upload-pages-artifact
// unchanged.
//
//   npx tsx scripts/compat-site.ts [outDir]     defaults to "site"
//
// Does not regenerate compat/aggregate.json or compat/version.json: the
// deploy workflow runs "compat:aggregate:check" and "compat:version:check"
// first, the same as "npm run verify", so a stale commit fails the deploy
// instead of quietly publishing something the corpus does not match.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_AGGREGATE_PATH } from '../src/compat/aggregate.js';
import type { CompatAggregate } from '../src/compat/aggregate.js';
import { DEFAULT_VERSION_PATH } from '../src/compat/version.js';
import type { CompatVersionDocument } from '../src/compat/version.js';
import { renderSite } from '../src/compat/site.js';

async function main(argv: string[]): Promise<number> {
  const outDir = argv[0] ?? 'site';

  const [aggregateRaw, versionRaw] = await Promise.all([
    readFile(DEFAULT_AGGREGATE_PATH, 'utf8'),
    readFile(DEFAULT_VERSION_PATH, 'utf8'),
  ]);
  const aggregate = JSON.parse(aggregateRaw) as CompatAggregate;
  const version = JSON.parse(versionRaw) as CompatVersionDocument;

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), renderSite(aggregate, version), 'utf8');
  // Copied rather than symlinked: actions/upload-pages-artifact tars the
  // directory it is given, and a real file is what survives that unchanged.
  await copyFile(DEFAULT_AGGREGATE_PATH, join(outDir, 'aggregate.json'));
  await copyFile(DEFAULT_VERSION_PATH, join(outDir, 'version.json'));

  console.error(`wrote ${outDir}/index.html, ${outDir}/aggregate.json, ${outDir}/version.json`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
