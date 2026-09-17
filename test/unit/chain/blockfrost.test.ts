import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockfrostProvider } from '../../../src/chain/blockfrost.js';
import { toHex } from '../../../src/encode/cbor.js';

/**
 * `submit()` is the only place a transaction's raw CBOR is ever seen by this
 * project. A rejected transaction never reaches a chain and cannot be
 * refetched or rebuilt afterwards, so the bytes have to be captured here or
 * they are gone permanently. This pins that capture on both outcomes rather
 * than trusting it to be remembered when transaction construction is built.
 */
describe('BlockfrostProvider.submit records the submitted CBOR', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const txCbor = new Uint8Array([0x83, 0x01, 0x02, 0x03]);

  it('carries cborHex alongside an accepted result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('"deadbeef"'),
      }),
    );
    const provider = new BlockfrostProvider('preprod', 'test-project-id');
    const result = await provider.submit(txCbor);
    expect(result).toEqual({ accepted: true, txHash: 'deadbeef', cborHex: toHex(txCbor) });
  });

  it('carries cborHex alongside a rejected result, since the bytes exist nowhere else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('MaxTxSizeUTxO supplied 16466 expected 16384'),
      }),
    );
    const provider = new BlockfrostProvider('preprod', 'test-project-id');
    const result = await provider.submit(txCbor);
    expect(result).toEqual({
      accepted: false,
      error: 'MaxTxSizeUTxO supplied 16466 expected 16384',
      cborHex: toHex(txCbor),
    });
  });
});
