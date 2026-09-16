import { describe, expect, it } from 'vitest';
import { TxCborWriter, writeSet } from '../../../src/chain/cbor.js';
import { toHex } from '../../../src/encode/cbor.js';

/**
 * The primitives `src/encode/cbor.ts` has no reason to carry: maps, tags,
 * raw splicing, and the `true`/`null` simple values a transaction wraps
 * itself in. Known answers below are RFC 8949 Appendix A's own worked
 * examples, so a divergence here is a bug in this writer rather than in the
 * expected value.
 */

describe('shortest-form integers, at each width boundary', () => {
  // RFC 8949 Appendix A, "Examples of Encoded CBOR Data Items": 0, 23, 24,
  // 1000 and 1000000 exercise the one-byte, two-byte, three-byte and
  // five-byte width classes respectively.
  it.each([
    [0, '00'],
    [23, '17'],
    [24, '1818'],
    [255, '18ff'],
    [256, '190100'],
    [1000, '1903e8'],
    [65535, '19ffff'],
    [65536, '1a00010000'],
    [1000000, '1a000f4240'],
    [4294967295, '1affffffff'],
    [4294967296, '1b0000000100000000'],
  ])('encodes %i as %s', (value, hex) => {
    expect(toHex(new TxCborWriter().uint(value).toBytes())).toBe(hex);
  });
});

describe('arrays and maps', () => {
  it('encodes an empty array as RFC 8949 shows it', () => {
    expect(toHex(new TxCborWriter().arrayHeader(0).toBytes())).toBe('80');
  });

  it('encodes [1, 2, 3] as RFC 8949 shows it', () => {
    const writer = new TxCborWriter().arrayHeader(3).uint(1).uint(2).uint(3);
    expect(toHex(writer.toBytes())).toBe('83010203');
  });

  it('encodes the empty map as RFC 8949 shows it', () => {
    expect(toHex(new TxCborWriter().mapHeader(0).toBytes())).toBe('a0');
  });

  it('encodes {1: 2, 3: 4} as RFC 8949 shows it', () => {
    const writer = new TxCborWriter().mapHeader(2).uint(1).uint(2).uint(3).uint(4);
    expect(toHex(writer.toBytes())).toBe('a201020304');
  });
});

describe('simple values', () => {
  it('encodes true and null as RFC 8949 shows them', () => {
    expect(toHex(new TxCborWriter().true().toBytes())).toBe('f5');
    expect(toHex(new TxCborWriter().null().toBytes())).toBe('f6');
  });
});

describe('tag 258, the CDDL set wrapper', () => {
  it('prefixes an array with the tag rather than replacing its header', () => {
    // #6.258 is a tag around a value, not a variant array header: the array
    // still carries its own definite-length header underneath.
    const writer = new TxCborWriter().tag(258).arrayHeader(1).uint(7);
    expect(toHex(writer.toBytes())).toBe('d9010281' + '07');
  });
});

describe('raw splicing', () => {
  it('inserts bytes unmodified, with no length-prefixing of its own', () => {
    // This is the primitive the whole builder exists for: a caller-supplied
    // native script's CBOR has to appear byte for byte, not as the payload
    // of a byte string this writer frames around it.
    const preEncoded = Uint8Array.from([0x82, 0x00, 0x01]);
    const writer = new TxCborWriter().arrayHeader(2).uint(9).raw(preEncoded);
    expect(toHex(writer.toBytes())).toBe('82' + '09' + '820001');
  });
});

describe('writeSet', () => {
  it('refuses to write an empty set rather than emitting a tagged empty array', () => {
    // Every set-typed field this builder touches is CDDL `nonempty_set`, and
    // an absent one is written by omitting the map key, not by writing
    // `#6.258([])`. Getting this backwards would produce a transaction whose
    // shape claims a field is present with nothing in it.
    expect(() => writeSet(new TxCborWriter(), [], () => {})).toThrow(RangeError);
  });

  it('writes tag 258 then each item in order', () => {
    const writer = new TxCborWriter();
    writeSet(writer, [1, 2, 3], (w, item) => w.uint(item));
    expect(toHex(writer.toBytes())).toBe('d9010283010203');
  });
});
