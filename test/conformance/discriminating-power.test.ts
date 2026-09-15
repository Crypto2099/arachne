import { describe, expect, it, beforeAll } from 'vitest';
import { parseScript } from '../../src/model/json.js';
import type { NativeScript } from '../../src/model/types.js';
import { loadAllVectors } from '../../src/vectors/load.js';
import type { Vector } from '../../src/vectors/schema.js';

/**
 * A corpus is only worth shipping if it can tell a correct implementation from
 * an incorrect one. This suite proves it can, by running the known-wrong
 * algorithm against it and requiring the corpus to catch it.
 *
 * If one of these ever stops failing, the corpus has lost coverage and the
 * families that provided it need looking at. That is why the assertions are
 * written the way round they are: the test passes when the flawed evaluator
 * disagrees with the recorded expectations.
 */
let corpus: Vector[];

beforeAll(async () => {
  corpus = await loadAllVectors();
});

interface Criteria {
  keys: string[];
  required: number;
  count: number;
}

/**
 * The flattening evaluator, reproduced as it appears in the wild.
 *
 * It walks the tree accumulating key hashes into a single list and a single
 * count, then sets `required` from whichever container type it saw last. Nested
 * structure is lost, timelocks are skipped entirely, and the key list is
 * compared against the supplied signatures as a set.
 *
 * This is not a straw man. It is the shape of `getScriptCriteria` in
 * ekklesia-helpers, which is in production.
 */
function flattenedCriteria(
  script: NativeScript,
  carry: Criteria = { keys: [], required: 1, count: 0 },
): Criteria {
  if (script.type === 'sig' || script.type === 'after' || script.type === 'before') return carry;

  for (const child of script.scripts) {
    switch (child.type) {
      case 'sig':
        carry.keys.push(child.keyHash);
        carry.count += 1;
        break;
      case 'after':
      case 'before':
        // Skipped. This is the defect that costs the most.
        break;
      default:
        carry = flattenedCriteria(child, carry);
        break;
    }
  }

  switch (script.type) {
    case 'all':
      carry.required = carry.count;
      break;
    case 'any':
      carry.required = 1;
      break;
    case 'atLeast':
      carry.required = script.required;
      break;
  }
  return carry;
}

function flattenedSatisfied(script: NativeScript, signers: string[]): boolean {
  const criteria = flattenedCriteria(script);
  const supplied = new Set(signers.map((s) => s.toLowerCase()));
  const met = new Set(criteria.keys.filter((k) => supplied.has(k.toLowerCase())));
  return met.size >= criteria.required;
}

describe('the corpus detects the flattening evaluator', () => {
  it('catches it somewhere', () => {
    const disagreements = corpus.flatMap((vector) => {
      const script = parseScript(vector.script);
      return vector.satisfaction
        .filter((c) => flattenedSatisfied(script, c.signers) !== c.expected)
        .map((c) => `${vector.id} ${c.id}`);
    });
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('catches each of the three defects independently', () => {
    const offendingFamilies = new Set<string>();
    for (const vector of corpus) {
      const script = parseScript(vector.script);
      for (const c of vector.satisfaction) {
        if (flattenedSatisfied(script, c.signers) !== c.expected) {
          offendingFamilies.add(vector.family);
          break;
        }
      }
    }

    // Duplicate keys under a threshold: lost by the key set.
    expect(offendingFamilies, 'duplicate-keys coverage lost').toContain('duplicate-keys');
    // Nested thresholds: lost by flattening.
    expect(offendingFamilies, 'nested-threshold coverage lost').toContain('nested-threshold');
    // Timelocks: skipped entirely.
    expect(offendingFamilies, 'timelocks coverage lost').toContain('timelocks');
    // Federations are the realistic shape that combines two of the three.
    expect(offendingFamilies, 'federation coverage lost').toContain('federation');
  });

  it('reports how much of the corpus discriminates', () => {
    let cases = 0;
    let caught = 0;
    for (const vector of corpus) {
      const script = parseScript(vector.script);
      for (const c of vector.satisfaction) {
        cases += 1;
        if (flattenedSatisfied(script, c.signers) !== c.expected) caught += 1;
      }
    }
    // A corpus where almost nothing discriminates is mostly padding. This is a
    // floor, not a target: the number moves as families are added.
    expect(caught / cases).toBeGreaterThan(0.05);
  });
});
