#!/usr/bin/env node
// Builds the Pages artifact: compat/aggregate.json, compat/version.json and
// chain-evidence/observations.json (all already committed, never
// regenerated here) plus the two pages rendered from them, all written flat
// into one output directory so the deploy workflow can hand the whole thing
// to actions/upload-pages-artifact unchanged.
//
//   npx tsx scripts/compat-site.ts [outDir]     defaults to "site"
//
// Does not regenerate any of its three source files: the deploy workflow
// runs "compat:aggregate:check", "compat:version:check" and
// "chain-evidence:record:check" first, the same as "npm run verify", so a
// stale commit fails the deploy instead of quietly publishing something the
// corpus or the record does not match.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_AGGREGATE_PATH } from '../src/compat/aggregate.js';
import type { CompatAggregate } from '../src/compat/aggregate.js';
import { DEFAULT_VERSION_PATH } from '../src/compat/version.js';
import type { CompatVersionDocument } from '../src/compat/version.js';
import { renderSite } from '../src/compat/site.js';
import { renderChainEvidenceSite } from '../src/compat/chain-evidence-site.js';
import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from '../src/chain/evidence.js';

async function main(argv: string[]): Promise<number> {
  const outDir = argv[0] ?? 'site';

  const [aggregateRaw, versionRaw, chainEvidence] = await Promise.all([
    readFile(DEFAULT_AGGREGATE_PATH, 'utf8'),
    readFile(DEFAULT_VERSION_PATH, 'utf8'),
    loadChainEvidence(DEFAULT_CHAIN_EVIDENCE_PATH),
  ]);
  const aggregate = JSON.parse(aggregateRaw) as CompatAggregate;
  const version = JSON.parse(versionRaw) as CompatVersionDocument;

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), renderSite(aggregate, version), 'utf8');
  await writeFile(
    join(outDir, 'chain-evidence.html'),
    renderChainEvidenceSite(chainEvidence),
    'utf8',
  );
  // Copied rather than symlinked: actions/upload-pages-artifact tars the
  // directory it is given, and a real file is what survives that unchanged.
  await copyFile(DEFAULT_AGGREGATE_PATH, join(outDir, 'aggregate.json'));
  await copyFile(DEFAULT_VERSION_PATH, join(outDir, 'version.json'));
  await copyFile(DEFAULT_CHAIN_EVIDENCE_PATH, join(outDir, 'chain-evidence.json'));

  console.error(
    `wrote ${outDir}/index.html, ${outDir}/aggregate.json, ${outDir}/version.json, ` +
      `${outDir}/chain-evidence.html, ${outDir}/chain-evidence.json`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
