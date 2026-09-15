import { describe, expect, it } from 'vitest';
import { REF_SCRIPT_LIMITS, refScriptFee, bundleBudget } from '../../src/chain/bundle.js';
import type { Vector } from '../../src/vectors/schema.js';

const MAX_TX_SIZE = 16_384;

function stubVector(id: string, cborBytes: number): Vector {
  return { id, encoding: { cborBytes } } as unknown as Vector;
}

describe('reference script fee tiering', () => {
  it('charges the base rate inside the first tier', () => {
    expect(refScriptFee(0)).toBe(0n);
    expect(refScriptFee(1)).toBe(15n);
    expect(refScriptFee(100)).toBe(1_500n);
    expect(refScriptFee(25_599)).toBe(383_985n);
  });

  it('advances a tier at exactly one stride', () => {
    // The ledger's guard is `n < sizeIncrement`, so a size of exactly one
    // stride falls through to the next tier rather than staying in this one.
    expect(refScriptFee(25_600)).toBe(384_000n);
    expect(refScriptFee(25_601)).toBe(384_018n); // 384000 + 1 * 18
  });

  it('applies the 1.2 multiplier per tier', () => {
    // Two full tiers: 25600 * 15 + 25600 * 18.
    expect(refScriptFee(51_200)).toBe(844_800n);
  });

  it('prices a full reference budget at roughly 6.34 ADA', () => {
    expect(refScriptFee(REF_SCRIPT_LIMITS.maxPerTx)).toBe(6_335_648n);
  });
});

describe('bundle budgets', () => {
  it('fits a small federation inline', () => {
    const budget = bundleBudget([stubVector('a', 300), stubVector('b', 500)], MAX_TX_SIZE, 400);
    expect(budget.fitsInline).toBe(true);
    expect(budget.totalScriptBytes).toBe(800);
  });

  it('pushes a set that is too large inline onto the reference route', () => {
    const vectors = Array.from({ length: 5 }, (_, i) => stubVector(`f${i}`, 12_800));
    const budget = bundleBudget(vectors, MAX_TX_SIZE, 400);
    expect(budget.fitsInline).toBe(false);
    expect(budget.fitsAsReferenceScripts).toBe(true);
    expect(budget.totalScriptBytes).toBe(64_000);
    expect(budget.notes.join(' ')).toMatch(/reference/i);
  });

  it('refuses a single script that no transaction can create', () => {
    // A reference script has to be created before it can be referenced, and the
    // creating transaction carries it in an output. So maxTxSize bounds one
    // script whichever route it takes.
    const budget = bundleBudget([stubVector('huge', 20_000)], MAX_TX_SIZE, 400);
    expect(budget.fitsInline).toBe(false);
    expect(budget.fitsAsReferenceScripts).toBe(false);
    expect(budget.uncreatableScripts).toEqual(['huge']);
  });

  it('reports a total above the per-transaction reference budget', () => {
    const vectors = Array.from({ length: 20 }, (_, i) => stubVector(`f${i}`, 12_800));
    const budget = bundleBudget(vectors, MAX_TX_SIZE, 400);
    expect(budget.totalScriptBytes).toBeGreaterThan(REF_SCRIPT_LIMITS.maxPerTx);
    expect(budget.fitsAsReferenceScripts).toBe(false);
    expect(budget.notes.join(' ')).toMatch(/non-distinct/);
  });
});
