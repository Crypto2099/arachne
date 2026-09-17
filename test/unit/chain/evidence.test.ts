import { describe, expect, it } from 'vitest';
import {
  loadChainEvidence,
  validateChainEvidenceEntry,
  validateChainEvidenceRecord,
  checkAgainstVector,
  CHAIN_EVIDENCE_FORMAT_VERSION,
} from '../../../src/chain/evidence.js';
import { loadAllVectors } from '../../../src/vectors/load.js';

/**
 * The chain evidence record is authored, not generated: it exists because
 * `onchain` cannot reach an observation that has no corpus vector to attach
 * to. That makes it exactly the kind of file a hand edit can quietly break,
 * so this suite checks the two things that would otherwise only be caught by
 * a human reading the JSON: that every entry is internally well formed, and
 * that every entry pointing at a vector still agrees with what that vector's
 * own `onchain` array, the one the verifier's contradiction check reads,
 * actually says.
 */
describe('chain-evidence/observations.json', () => {
  it('is at the format version this module reads', async () => {
    const record = await loadChainEvidence();
    expect(record.formatVersion).toBe(CHAIN_EVIDENCE_FORMAT_VERSION);
  });

  it('has no shape problems', async () => {
    const record = await loadChainEvidence();
    expect(validateChainEvidenceRecord(record)).toEqual([]);
  });

  it('reports entryCount matching the number of entries', async () => {
    const record = await loadChainEvidence();
    expect(record.entryCount).toBe(record.entries.length);
  });

  // Stated separately from the aggregate shape check above so a rule that
  // regresses names itself rather than hiding inside one combined assertion.
  it.each([
    [
      'an accepted entry always carries a txHash',
      (e: { accepted: boolean; txHash?: string }) => !e.accepted || Boolean(e.txHash),
    ],
    [
      'a rejected entry always carries an error',
      (e: { accepted: boolean; error?: string }) => e.accepted || Boolean(e.error),
    ],
  ])('%s', async (_description, predicate) => {
    const record = await loadChainEvidence();
    const violations = record.entries.filter((e) => !predicate(e));
    expect(violations).toEqual([]);
  });

  it('gives every txHash as 64 lowercase hex characters', async () => {
    const record = await loadChainEvidence();
    const bad = record.entries
      .map((e) => e.txHash)
      .filter((hash): hash is string => hash !== undefined)
      .filter((hash) => !/^[0-9a-f]{64}$/.test(hash));
    expect(bad).toEqual([]);
  });

  it('has no duplicate txHash across entries', async () => {
    const record = await loadChainEvidence();
    const hashes = record.entries.map((e) => e.txHash).filter((h): h is string => h !== undefined);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('validates each entry with no problems, individually', async () => {
    const record = await loadChainEvidence();
    for (const entry of record.entries) {
      expect(validateChainEvidenceEntry(entry), JSON.stringify(entry)).toEqual([]);
    }
  });

  /**
   * The check that catches the record and a vector's `onchain` array
   * drifting apart. Every entry naming a `vectorId` must agree with that
   * vector on network, txHash and accepted, because those are the fields a
   * reader would use this record to answer without opening the vector at
   * all.
   */
  it('agrees with every vector it cross-references on network, txHash and accepted', async () => {
    const record = await loadChainEvidence();
    const vectors = await loadAllVectors();
    const problems = record.entries.flatMap((entry) => checkAgainstVector(entry, vectors));
    expect(problems).toEqual([]);
  });

  it('does not modify the five vectors that already carry these observations', async () => {
    const record = await loadChainEvidence();
    const vectors = await loadAllVectors();
    const linked = record.entries.filter((e) => e.vectorId);
    expect(linked.length).toBeGreaterThan(0);

    for (const entry of linked) {
      const vector = vectors.find((v) => v.id === entry.vectorId);
      expect(vector, `vector ${entry.vectorId} not found on disk`).toBeDefined();
      // The vector's own onchain array is the authority; this only checks
      // that it still exists and still carries at least one observation,
      // which is what "the record cross-references it" depends on.
      expect(vector?.onchain?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
