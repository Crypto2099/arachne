import { describe, expect, it } from 'vitest';
import { parseScript, ScriptParseError } from '../../src/model/json.js';
import { encodeScript } from '../../src/encode/script.js';
import { decodeScript, scriptHashFromCbor, CborDecodeError } from '../../src/encode/decode.js';

/**
 * `slot` is `uint` in the CDDL: 0 to 2^64-1. Two ranges sit outside that and
 * behave very differently from an unsatisfiable script.
 *
 * Below zero and above 2^64-1 are not slots at all. A transaction carrying one
 * is refused by the node's DECODER, confirmed on preprod: `before(-1)` and a
 * bignum `before(2^64)` both came back DecoderErrorDeserialiseFailure. The
 * script still hashes to something and still yields a fundable address, so
 * nothing stops the funds going in and nothing lets them out.
 *
 * Between 2^53-1 and 2^64-1 the slot is perfectly legal but this AST cannot
 * hold it exactly. That gap used to corrupt silently: slot 2^60+1 decoded to
 * 2^60, re-encoded to different bytes and produced a different script hash, so
 * a decode-and-rehash returned the wrong address with nothing raised.
 */
describe('slots outside the uint range are refused, not mangled', () => {
  it('refuses to encode a negative slot', () => {
    expect(() => encodeScript({ type: 'after', slot: -1 }, 'definite')).toThrow(/non-negative/);
  });

  it('refuses to encode a fractional slot', () => {
    expect(() => encodeScript({ type: 'before', slot: 1.5 }, 'definite')).toThrow(/integer/);
  });

  it('refuses to parse a slot it cannot hold exactly', () => {
    expect(() => parseScript({ type: 'after', slot: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      ScriptParseError,
    );
  });
});

describe('a legal slot above MAX_SAFE_INTEGER is refused rather than truncated', () => {
  // 2^60 + 1: inside uint64, outside exact JavaScript integers.
  const slot = (1n << 60n) + 1n;
  const cbor = `8205${'1b'}${slot.toString(16).padStart(16, '0')}`;

  it('refuses to decode it', () => {
    expect(() => decodeScript(cbor)).toThrow(CborDecodeError);
    expect(() => decodeScript(cbor)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('still hashes correctly without decoding', () => {
    // The escape hatch the decoder's message points at. Hashing received bytes
    // never needs to understand them.
    expect(scriptHashFromCbor(cbor)).toBe(
      'cda60d5332371a1ad8d5ab6136ee242a01b24ed6c8af5fd4bbf437aa',
    );
  });

  it('would have produced a different hash if truncated', () => {
    // What the old behavior did: 2^60+1 became 2^60, a different script.
    const truncated = `8205${'1b'}${(1n << 60n).toString(16).padStart(16, '0')}`;
    expect(scriptHashFromCbor(truncated)).not.toBe(scriptHashFromCbor(cbor));
  });
});

describe('the legal range still works end to end', () => {
  it.each([0, 1, 133_854_050, Number.MAX_SAFE_INTEGER])('round trips slot %i', (slot) => {
    const bytes = encodeScript({ type: 'after', slot }, 'definite');
    const decoded = decodeScript(bytes);
    expect((decoded.script as { slot: number }).slot).toBe(slot);
  });
});
