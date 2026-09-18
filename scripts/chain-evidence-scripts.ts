#!/usr/bin/env node
// Regenerates chain-evidence/scripts.json from chain-evidence/observations.json.
// It is the set of native scripts a real node has actually carried, pulled out
// of the transaction bytes the observations record, deduplicated by bytes and
// keyed by script hash.
//
//   npx tsx scripts/chain-evidence-scripts.ts            write chain-evidence/scripts.json
//   npx tsx scripts/chain-evidence-scripts.ts --check    fail if the committed file is stale
//
// --check is what CI and "npm run verify" run: it never writes, so a
// hand-edited scripts.json, or one left behind after observations.json
// changed, fails the build the same way a hand-edited vector does. Like
// scripts/chain-evidence-record.ts, this never writes observations.json
// itself; that file is authored, not generated (chain-evidence/README.md).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from '../src/chain/evidence.js';
import {
  DEFAULT_OBSERVED_SCRIPTS_PATH,
  deriveObservedScripts,
  serializeObservedScripts,
} from '../src/chain/observed.js';
import { loadAllVectors } from '../src/vectors/load.js';

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');

  if (!existsSync(DEFAULT_CHAIN_EVIDENCE_PATH)) {
    console.error(`${DEFAULT_CHAIN_EVIDENCE_PATH} does not exist.`);
    return 1;
  }

  const record = await loadChainEvidence(DEFAULT_CHAIN_EVIDENCE_PATH);
  // Vectors are loaded only to recognize an observed byte string as one the
  // corpus also generates. A missing corpus would silently drop every
  // vectorId, so this reads it rather than treating it as optional.
  const vectors = await loadAllVectors();
  const derived = deriveObservedScripts(record, vectors);
  const rendered = serializeObservedScripts(derived);

  const linked = derived.scripts.filter((s) => s.vectorId).length;
  const undecodable = derived.scripts.filter((s) => !s.decodable).length;
  const summary = `${derived.scriptCount} distinct scripts, ${linked} matching a corpus vector, ${undecodable} this library cannot decode`;

  if (check) {
    if (!existsSync(DEFAULT_OBSERVED_SCRIPTS_PATH)) {
      console.error(
        `${DEFAULT_OBSERVED_SCRIPTS_PATH} does not exist. Run "npm run chain-evidence:scripts" first.`,
      );
      return 1;
    }
    const onDisk = await readFile(DEFAULT_OBSERVED_SCRIPTS_PATH, 'utf8');
    if (onDisk === rendered) {
      console.error(
        `${DEFAULT_OBSERVED_SCRIPTS_PATH} matches ${DEFAULT_CHAIN_EVIDENCE_PATH} (${summary})`,
      );
      return 0;
    }
    console.error(
      `${DEFAULT_OBSERVED_SCRIPTS_PATH} does not match what ${DEFAULT_CHAIN_EVIDENCE_PATH} produces.`,
    );
    console.error('Run "npm run chain-evidence:scripts" and commit the result.');
    return 1;
  }

  await writeFile(DEFAULT_OBSERVED_SCRIPTS_PATH, rendered, 'utf8');
  console.error(`wrote ${DEFAULT_OBSERVED_SCRIPTS_PATH}: ${summary}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
