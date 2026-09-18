import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildChainEvidenceRecordMarkdown,
  CHAIN_EVIDENCE_TOPICS,
  classifyChainEvidence,
  DEFAULT_CHAIN_EVIDENCE_RECORD_PATH,
  explorerTxUrl,
  renderChainEvidenceRecord,
} from '../../../src/chain/record.js';
import { loadChainEvidence } from '../../../src/chain/evidence.js';
import type { ChainEvidenceEntry } from '../../../src/chain/evidence.js';

/**
 * Mirrors test/unit/compat/version.test.ts and aggregate.test.ts: the
 * record this suite is guarding is a document a reader trusts precisely
 * because regenerating it from the same JSON always produces the same
 * bytes, so that property is what most of these tests pin down directly
 * rather than only checking the prose reads sensibly.
 */

// Both match the nesting-depth topic by source alone, with no vectorId, so
// a fixture built from either reaches classification and rendering the
// same way a real entry would, rather than being rejected before either
// check this file means to exercise gets a chance to run.
function acceptedEntry(overrides: Partial<ChainEvidenceEntry> = {}): ChainEvidenceEntry {
  return {
    network: 'preprod',
    accepted: true,
    txHash: 'a'.repeat(64),
    demonstrates: 'A fixture entry.',
    source: 'spec/06-chain-exercises.md, "How deep a single script can nest"',
    ...overrides,
  };
}

function refusedEntry(overrides: Partial<ChainEvidenceEntry> = {}): ChainEvidenceEntry {
  return {
    network: 'preprod',
    accepted: false,
    error: 'MaxTxSizeUTxO supplied 1 expected 0',
    demonstrates: 'A fixture entry.',
    source: 'spec/06-chain-exercises.md, "How deep a single script can nest"',
    ...overrides,
  };
}

// `exactOptionalPropertyTypes` treats "key absent" and "key present with
// value undefined" as different things, and only the first is a valid
// ChainEvidenceEntry; this drops a key entirely so a fixture can omit
// txHash or error the same way a real malformed entry would, rather than
// carrying it explicitly set to undefined.
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

describe('explorerTxUrl', () => {
  // https://preprod.cexplorer.io/tx/b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2
  // was fetched with a headless browser while this generator was written:
  // it renders that transaction's real fee and labels the network
  // "Preprod", and the same path for a hash that does not exist renders a
  // page that says so instead. This pins the exact pattern that was
  // checked, not a plausible-looking one nobody fetched.
  it('links a preprod hash to the pattern that was fetched and confirmed', () => {
    const hash = 'b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2';
    expect(explorerTxUrl('preprod', hash)).toBe(`https://preprod.cexplorer.io/tx/${hash}`);
  });

  // No explorer was fetched and confirmed for mainnet or preview against
  // this record, which carries only preprod hashes today. Emitting a link
  // nobody tested would be exactly the dead link the task warns against.
  it.each(['mainnet', 'preview'] as const)('leaves a %s hash unlinked', (network) => {
    expect(explorerTxUrl(network, 'b'.repeat(64))).toBeNull();
  });
});

describe('classifyChainEvidence', () => {
  it('sorts every entry in the real record into exactly one topic', async () => {
    const record = await loadChainEvidence();
    const byTopic = classifyChainEvidence(record.entries);
    const total = [...byTopic.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(record.entries.length);
  });

  it('gives every topic at least one entry against the real record', async () => {
    // A topic with no entries would be a heading over an empty section, the
    // same gap test/conformance/discriminating-power.test.ts pins a family
    // against for the corpus.
    const record = await loadChainEvidence();
    const byTopic = classifyChainEvidence(record.entries);
    for (const topic of CHAIN_EVIDENCE_TOPICS) {
      expect(byTopic.get(topic.id)?.length ?? 0, `topic "${topic.id}" is empty`).toBeGreaterThan(0);
    }
  });

  it('throws when no topic matches an entry', () => {
    const stray = acceptedEntry({ source: 'spec/99-nowhere.md, "Not a real section"' });
    expect(() => classifyChainEvidence([stray])).toThrow(/no topic/);
  });

  // The regression this guards: the degenerate/empty-any acceptance cites
  // spec/01-script-model.md, the same section the malformed-bytes topic
  // matches on, because it explains why a script that can never be spent
  // can still reach the chain as a reference script. It must stay with the
  // rest of that vector's story rather than fall into a section about
  // decoder failures it has nothing to do with.
  it('keeps a vectorId-bearing entry out of malformed-bytes even when it cites that section', () => {
    const referenceScriptStored = acceptedEntry({
      vectorId: 'degenerate/empty-any',
      source: 'spec/01-script-model.md, "What it takes for a script to reach the chain"',
    });
    const byTopic = classifyChainEvidence([referenceScriptStored]);
    expect(byTopic.get('degenerate-thresholds')).toEqual([referenceScriptStored]);
    expect(byTopic.get('malformed-bytes')).toEqual([]);
  });
});

describe('renderChainEvidenceRecord', () => {
  it('is byte-stable: rendering the same record twice produces identical bytes', async () => {
    const record = await loadChainEvidence();
    const first = renderChainEvidenceRecord(record);
    const second = renderChainEvidenceRecord(record);
    expect(first).toBe(second);
  });

  // Requirement: no field may come from the clock, so an ISO timestamp
  // stamped at generation time must never appear anywhere in the output.
  // The record's own optional `observedAt` values are not rendered, which
  // this also confirms by construction: none of them are ISO-8601 either,
  // but this catches a `new Date().toISOString()` slipped in by accident.
  it('carries no ISO-8601 timestamp anywhere in the rendered document', async () => {
    const record = await loadChainEvidence();
    const rendered = renderChainEvidenceRecord(record);
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('renders an accepted entry as a linked hash and a refused entry with a fenced verbatim error', () => {
    const record = {
      formatVersion: 1,
      entryCount: 2,
      entries: [
        acceptedEntry({ demonstrates: 'An accepted fixture.' }),
        refusedEntry({
          error: 'MaxTxSizeUTxO supplied 1 expected 0',
          demonstrates: 'A refused fixture.',
        }),
      ],
    };

    const rendered = renderChainEvidenceRecord(record);

    expect(rendered).toContain(
      `[\`${'a'.repeat(64)}\`](https://preprod.cexplorer.io/tx/${'a'.repeat(64)})`,
    );
    expect(rendered).toContain('**Refused** on preprod. No transaction reached a chain.');
    expect(rendered).toContain('```\n  MaxTxSizeUTxO supplied 1 expected 0\n  ```');
  });

  it('throws rather than silently omitting an accepted entry with no txHash', () => {
    const record = {
      formatVersion: 1,
      entryCount: 1,
      entries: [omit(acceptedEntry(), 'txHash')],
    };
    expect(() => renderChainEvidenceRecord(record)).toThrow(/no txHash/);
  });

  it('throws rather than silently omitting a refused entry with no error', () => {
    const record = {
      formatVersion: 1,
      entryCount: 1,
      entries: [omit(refusedEntry(), 'error')],
    };
    expect(() => renderChainEvidenceRecord(record)).toThrow(/no error/);
  });
});

describe('the committed chain-evidence/record.md', () => {
  // Mirrors test/unit/compat/aggregate.test.ts and version.test.ts: a hand
  // edit, or a file left stale after observations.json changed underneath
  // it, fails here as well as in "npm run chain-evidence:record:check".
  it('matches what observations.json produces right now', async () => {
    const rendered = await buildChainEvidenceRecordMarkdown();
    const onDisk = await readFile(DEFAULT_CHAIN_EVIDENCE_RECORD_PATH, 'utf8');
    expect(rendered).toBe(onDisk);
  });
});
