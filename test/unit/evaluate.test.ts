import { describe, expect, it } from 'vitest';
import { parseScript } from '../../src/model/json.js';
import { evaluate } from '../../src/evaluate/evaluate.js';
import { cosigners } from '../../src/generate/cosigners.js';

const [A, B, C] = cosigners(3) as [string, string, string];

const sig = (keyHash: string) => ({ type: 'sig' as const, keyHash });

describe('thresholds count satisfied sub-scripts, not distinct keys', () => {
  it('lets one signature satisfy a duplicated key twice', () => {
    // The same key hash twice under atLeast 2. The ledger counts satisfied
    // sub-scripts, so a single signature covers both slots. An implementation
    // that collects key hashes into a set sees one key against a threshold of
    // two and reports false.
    const script = parseScript({ type: 'atLeast', required: 2, scripts: [sig(A), sig(A)] });
    expect(evaluate(script, { signers: [A] }).satisfied).toBe(true);
  });

  it('is satisfied with no witnesses when required is zero', () => {
    const script = parseScript({ type: 'atLeast', required: 0, scripts: [sig(A), sig(B)] });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(true);
  });

  it('can never be satisfied when required exceeds the child count', () => {
    const script = parseScript({ type: 'atLeast', required: 3, scripts: [sig(A), sig(B)] });
    expect(evaluate(script, { signers: [A, B] }).satisfied).toBe(false);
  });
});

describe('nesting does not flatten', () => {
  it('requires the outer sig and one of the inner pair, not all three', () => {
    // all[ any[A, B], sig C ]. An accumulator that walks the tree collecting key
    // hashes and sets required to the total count demands A, B and C together.
    const script = parseScript({
      type: 'all',
      scripts: [{ type: 'any', scripts: [sig(A), sig(B)] }, sig(C)],
    });
    expect(evaluate(script, { signers: [A, C] }).satisfied).toBe(true);
    expect(evaluate(script, { signers: [B, C] }).satisfied).toBe(true);
    expect(evaluate(script, { signers: [A, B] }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [C] }).satisfied).toBe(false);
  });

  it('evaluates a threshold nested inside a threshold on its own terms', () => {
    // atLeast 2 of [ sig A, atLeast 2 of [B, C] ]. The inner group is one vote.
    const script = parseScript({
      type: 'atLeast',
      required: 2,
      scripts: [sig(A), { type: 'atLeast', required: 2, scripts: [sig(B), sig(C)] }],
    });
    expect(evaluate(script, { signers: [A, B, C] }).satisfied).toBe(true);
    expect(evaluate(script, { signers: [A, B] }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [B, C] }).satisfied).toBe(false);
  });
});

describe('timelocks against the transaction validity interval', () => {
  it('fails an "after" when the transaction declares no validity start', () => {
    // This is the case most often wrong in a consumer. An unbounded transaction
    // does not pass the timelock and does not skip it. It fails.
    const script = parseScript({ type: 'after', slot: 1000 });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [], validityStart: 1000 }).satisfied).toBe(true);
    expect(evaluate(script, { signers: [], validityStart: 999 }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [], validityStart: 1001 }).satisfied).toBe(true);
  });

  it('fails a "before" when the transaction declares no validity end', () => {
    const script = parseScript({ type: 'before', slot: 1000 });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [], validityEnd: 1000 }).satisfied).toBe(true);
    expect(evaluate(script, { signers: [], validityEnd: 1001 }).satisfied).toBe(false);
  });

  it('refuses a signed script whose timelock the transaction does not bound', () => {
    // A signature is not enough when the script also carries a timelock. This
    // is the shape of the Ekklesia DRep fixture, and a signature-only evaluator
    // reports it satisfied.
    const script = parseScript({
      type: 'all',
      scripts: [sig(A), { type: 'after', slot: 1 }],
    });
    expect(evaluate(script, { signers: [A] }).satisfied).toBe(false);
    expect(evaluate(script, { signers: [A], validityStart: 1 }).satisfied).toBe(true);
  });

  it('can never satisfy a window whose lower bound is above its upper bound', () => {
    const script = parseScript({
      type: 'all',
      scripts: [
        { type: 'after', slot: 9000 },
        { type: 'before', slot: 1000 },
      ],
    });
    for (const slot of [0, 999, 1000, 9000, 9001]) {
      expect(
        evaluate(script, { signers: [], validityStart: slot, validityEnd: slot }).satisfied,
      ).toBe(false);
    }
  });
});

describe('empty containers', () => {
  it('treats an empty "all" as vacuously satisfied', () => {
    expect(evaluate(parseScript({ type: 'all', scripts: [] }), { signers: [] }).satisfied).toBe(
      true,
    );
  });

  it('treats an empty "any" as unsatisfiable', () => {
    expect(evaluate(parseScript({ type: 'any', scripts: [] }), { signers: [] }).satisfied).toBe(
      false,
    );
  });
});

describe('traces', () => {
  it('names the unsatisfied signer rather than only the verdict', () => {
    const script = parseScript({ type: 'all', scripts: [sig(A), sig(B)] });
    const result = evaluate(script, { signers: [A] });
    expect(result.satisfied).toBe(false);
    expect(result.missingSigners).toEqual([B]);
  });
});

describe('degenerate thresholds match isValidMOf', () => {
  // The ledger's isValidMOf short-circuits on `n <= 0` at every step, including
  // the first, which settles all three of these without special handling.
  it('satisfies a negative threshold with no witnesses', () => {
    const script = parseScript({ type: 'atLeast', required: -1, scripts: [] });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(true);
  });

  it('satisfies a zero threshold over an empty list', () => {
    const script = parseScript({ type: 'atLeast', required: 0, scripts: [] });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(true);
  });

  it('never satisfies a threshold above the child count', () => {
    const script = parseScript({ type: 'atLeast', required: 1, scripts: [] });
    expect(evaluate(script, { signers: [] }).satisfied).toBe(false);
  });
});
