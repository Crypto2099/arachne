import { describe, expect, it } from 'vitest';
import {
  maxLinearNestDepth,
  maxUnanimousInline,
  maxUnanimousByReference,
  scriptBudget,
  VKEY_WITNESS_BYTES,
} from '../../../src/chain/ceilings.js';

/**
 * Every ceiling this project reports is a consequence of `maxTxSize`, a protocol
 * parameter governance can change. These are therefore functions rather than
 * constants, and these tests pin them to what a real node actually did at the
 * parameter set in force when the measurements were taken: preprod epoch 313,
 * `maxTxSize` 16,384.
 *
 * If the formulas drift from the observations, the formulas are wrong. The
 * observations are transactions.
 */
const MEASURED_MAX_TX_SIZE = 16_384;

describe('the ceilings reproduce what preprod accepted and refused', () => {
  it('gives 5383 for a linear nest, the depth accepted with 5384 refused', () => {
    // Accepted f90dce57..., refused at 5384 with MaxTxSizeUTxO.
    expect(maxLinearNestDepth(MEASURED_MAX_TX_SIZE)).toBe(5383);
  });

  it('gives 122 for a unanimous multisig inline, the size accepted with 123 refused', () => {
    // Accepted 1d40d02c..., refused at 123 with MaxTxSizeUTxO.
    expect(maxUnanimousInline(MEASURED_MAX_TX_SIZE)).toBe(122);
  });

  it('gives 160 for a unanimous multisig by reference, the size accepted with 161 refused', () => {
    // Accepted ebccf64c..., refused at 161 with MaxTxSizeUTxO.
    expect(maxUnanimousByReference(MEASURED_MAX_TX_SIZE)).toBe(160);
  });
});

describe('the ceilings move with the parameter', () => {
  // The point of making these functions. A governance action that changes
  // maxTxSize changes every number this project reports, and nothing here
  // should have to be edited for that to be true.
  it('scales with a larger limit', () => {
    expect(maxLinearNestDepth(32_768)).toBeGreaterThan(maxLinearNestDepth(16_384));
    expect(maxUnanimousInline(32_768)).toBeGreaterThan(maxUnanimousInline(16_384));
    expect(maxUnanimousByReference(32_768)).toBeGreaterThan(maxUnanimousByReference(16_384));
  });

  it('shrinks with a smaller one', () => {
    expect(maxUnanimousInline(8_192)).toBeLessThan(maxUnanimousInline(16_384));
  });

  it('reaches zero rather than going negative when nothing fits', () => {
    expect(maxUnanimousInline(200)).toBe(0);
    expect(maxLinearNestDepth(200)).toBeLessThanOrEqual(0);
  });
});

describe('the script budget accounts for witnesses', () => {
  it('charges each signer a full witness', () => {
    const one = scriptBudget(MEASURED_MAX_TX_SIZE, 1);
    const two = scriptBudget(MEASURED_MAX_TX_SIZE, 2);
    expect(one - two).toBe(VKEY_WITNESS_BYTES);
  });
});
