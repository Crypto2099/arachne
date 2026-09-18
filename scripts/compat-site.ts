#!/usr/bin/env node
// Builds the Pages artifact: every page under src/compat/site/, rendered from
// the committed compat data, chain evidence record and corpus, plus the data
// files themselves copied beside the pages, all written into one output
// directory so the deploy workflow can hand the whole thing to
// actions/upload-pages-artifact unchanged.
//
//   npx tsx scripts/compat-site.ts [outDir]     defaults to "site"
//
// Does not regenerate any of its source files: the deploy workflow runs
// "compat:aggregate:check", "compat:version:check",
// "chain-evidence:record:check" and "chain-evidence:scripts:check" first,
// the same as "npm run verify", so a stale commit fails the deploy instead
// of quietly publishing something the corpus or the record does not match.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_AGGREGATE_PATH } from '../src/compat/aggregate.js';
import { DEFAULT_VERSION_PATH } from '../src/compat/version.js';
import { DEFAULT_RESULTS_DIR, resultPath } from '../src/compat/results.js';
import { DEFAULT_CHAIN_EVIDENCE_PATH } from '../src/chain/evidence.js';
import { DEFAULT_OBSERVED_SCRIPTS_PATH } from '../src/chain/observed.js';
import { loadSiteData, renderSitePages, resultFileStem } from '../src/compat/site/index.js';

async function main(argv: string[]): Promise<number> {
  const outDir = argv[0] ?? 'site';
  const data = await loadSiteData();
  const pages = renderSitePages(data);

  let written = 0;
  for (const [path, html] of pages) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html, 'utf8');
    written += 1;
  }

  // Copied rather than symlinked: actions/upload-pages-artifact tars the
  // directory it is given, and a real file is what survives that unchanged.
  // The result files are served beside the page rendered from each one, at
  // the same file name the repository commits them under.
  const copies: [string, string][] = [
    [DEFAULT_AGGREGATE_PATH, 'aggregate.json'],
    [DEFAULT_VERSION_PATH, 'version.json'],
    [DEFAULT_CHAIN_EVIDENCE_PATH, 'chain-evidence.json'],
    [DEFAULT_OBSERVED_SCRIPTS_PATH, 'scripts.json'],
  ];
  for (const tool of data.aggregate.tools) {
    for (const result of data.results.get(tool.id) ?? []) {
      copies.push([
        resultPath(tool.id, result.version, DEFAULT_RESULTS_DIR, result.path),
        join('results', tool.id, `${resultFileStem(result)}.json`),
      ]);
    }
  }
  for (const [source, target] of copies) {
    const path = join(outDir, target);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(source, path);
  }

  console.error(`wrote ${written} pages and ${copies.length} data files under ${outDir}/`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
