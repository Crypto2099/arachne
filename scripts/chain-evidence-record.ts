#!/usr/bin/env node
// Regenerates chain-evidence/record.md from chain-evidence/observations.json.
// This is the human-readable half of the chain evidence record: the JSON is
// what a program reads, this is what a person reads, and this script is
// what keeps the second from drifting off the first.
//
//   npx tsx scripts/chain-evidence-record.ts            write chain-evidence/record.md
//   npx tsx scripts/chain-evidence-record.ts --check    fail if the committed file is stale
//
// --check is what CI and "npm run verify" run: it never writes, so a
// hand-edited record.md, or one left behind after observations.json
// changed, fails the build the same way a hand-edited vector does. This
// script never writes chain-evidence/observations.json itself; that file is
// authored, not generated, and stays that way (chain-evidence/README.md).
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from '../src/chain/evidence.js';
import {
  renderChainEvidenceRecord,
  DEFAULT_CHAIN_EVIDENCE_RECORD_PATH,
} from '../src/chain/record.js';

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check');

  if (!existsSync(DEFAULT_CHAIN_EVIDENCE_PATH)) {
    console.error(`${DEFAULT_CHAIN_EVIDENCE_PATH} does not exist.`);
    return 1;
  }

  const record = await loadChainEvidence(DEFAULT_CHAIN_EVIDENCE_PATH);
  const rendered = renderChainEvidenceRecord(record);

  if (check) {
    if (!existsSync(DEFAULT_CHAIN_EVIDENCE_RECORD_PATH)) {
      console.error(
        `${DEFAULT_CHAIN_EVIDENCE_RECORD_PATH} does not exist. Run "npm run chain-evidence:record" first.`,
      );
      return 1;
    }
    const onDisk = await readFile(DEFAULT_CHAIN_EVIDENCE_RECORD_PATH, 'utf8');
    if (onDisk === rendered) {
      console.error(
        `${DEFAULT_CHAIN_EVIDENCE_RECORD_PATH} matches ${DEFAULT_CHAIN_EVIDENCE_PATH} (${record.entryCount} entries)`,
      );
      return 0;
    }
    console.error(
      `${DEFAULT_CHAIN_EVIDENCE_RECORD_PATH} does not match what ${DEFAULT_CHAIN_EVIDENCE_PATH} produces.`,
    );
    console.error('Run "npm run chain-evidence:record" and commit the result.');
    return 1;
  }

  await writeFile(DEFAULT_CHAIN_EVIDENCE_RECORD_PATH, rendered, 'utf8');
  console.error(`wrote ${DEFAULT_CHAIN_EVIDENCE_RECORD_PATH}: ${record.entryCount} entries`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
