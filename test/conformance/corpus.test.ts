import { describe, expect, it, beforeAll } from 'vitest';
import { FAMILIES } from '../../src/generate/families.js';
import { buildVector, corpusDigest } from '../../src/vectors/build.js';
import { loadAllVectors, loadIndex } from '../../src/vectors/load.js';
import { verifyCorpus, contradictions } from '../../src/vectors/verify.js';
import { VECTOR_FORMAT_VERSION, type Vector } from '../../src/vectors/schema.js';

/**
 * The committed corpus is the specification's executable half, so it is checked
 * the same way a port would check it. A failure here means either the corpus
 * drifted from the generator or the generator changed without the corpus being
 * rebuilt, and the fix is `npm run vectors:build` followed by reviewing the
 * diff, never editing a vector by hand.
 */
let corpus: Vector[];

beforeAll(async () => {
  corpus = await loadAllVectors();
});

describe('committed corpus', () => {
  it('is present', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('re-derives to the values it records', () => {
    const findings = verifyCorpus(corpus);
    const report = findings
      .map(
        (f) =>
          `${f.kind} ${f.vectorId}: ${f.detail}\n  expected ${f.expected}\n  actual ${f.actual}`,
      )
      .join('\n');
    expect(report).toBe('');
  });

  it('matches what the generator produces today', () => {
    const regenerated = FAMILIES.flatMap((family) =>
      family.cases().map((params) => buildVector(family, params)),
    );
    expect(corpusDigest(regenerated)).toBe(corpusDigest(corpus));
  });

  it('agrees with its own index', async () => {
    const index = await loadIndex();
    expect(index.formatVersion).toBe(VECTOR_FORMAT_VERSION);
    expect(index.vectorCount).toBe(corpus.length);
    expect(index.digest).toBe(corpusDigest(corpus));
    for (const entry of index.vectors) {
      const vector = corpus.find((v) => v.id === entry.id);
      expect(vector, `index lists ${entry.id} but no such vector exists`).toBeDefined();
      expect(vector?.encoding.scriptHash).toBe(entry.scriptHash);
    }
  });

  it('gives every vector a unique script hash or says why not', () => {
    // Two vectors sharing a hash means two generators produced the same script,
    // which is duplicated coverage rather than a defect. It should be visible.
    const byHash = new Map<string, string[]>();
    for (const vector of corpus) {
      const ids = byHash.get(vector.encoding.scriptHash) ?? [];
      ids.push(vector.id);
      byHash.set(vector.encoding.scriptHash, ids);
    }
    const collisions = [...byHash.values()].filter((ids) => ids.length > 1);
    expect(collisions, `duplicate scripts: ${JSON.stringify(collisions)}`).toEqual([]);
  });
});

describe('chain observations', () => {
  it('never contradicts the reference evaluator without that being surfaced', () => {
    // A contradiction is a finding against the spec, not against the node. This
    // test failing means the reference evaluator needs correcting and the
    // affected vectors rebuilding. It does not mean the observation is wrong.
    const found = corpus.flatMap(contradictions);
    const report = found
      .map((f) => `${f.vectorId}: ${f.detail} (${f.expected}, ${f.actual})`)
      .join('\n');
    expect(report).toBe('');
  });

  it('carries a transaction hash for every accepted submission', () => {
    for (const vector of corpus) {
      for (const observation of vector.onchain ?? []) {
        if (observation.accepted) {
          expect(
            observation.txHash,
            `${vector.id} claims acceptance with no transaction hash`,
          ).toBeTruthy();
        } else {
          expect(
            observation.error,
            `${vector.id} claims rejection with no error text`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe('coverage', () => {
  it('covers every family', () => {
    const covered = new Set(corpus.map((v) => v.family));
    for (const family of FAMILIES) expect(covered.has(family.name)).toBe(true);
  });

  it('brackets the transaction size limit', () => {
    // maxTxSize on mainnet and both testnets is 16384 bytes. The corpus is only
    // useful for the size question if it contains scripts on both sides of it.
    const sizes = corpus.map((v) => v.encoding.cborBytes);
    expect(Math.min(...sizes)).toBeLessThan(100);
    expect(Math.max(...sizes)).toBeGreaterThan(8_000);
  });

  it('reaches a nesting depth no ordinary wallet produces', () => {
    expect(Math.max(...corpus.map((v) => v.shape.depth))).toBeGreaterThanOrEqual(32);
  });

  it('includes cases no witness set can satisfy and cases any can', () => {
    const allCases = corpus.flatMap((v) => v.satisfaction);
    expect(allCases.some((c) => c.expected && c.signers.length === 0)).toBe(true);
    expect(allCases.some((c) => !c.expected)).toBe(true);
  });
});
