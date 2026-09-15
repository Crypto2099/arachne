import { describe, expect, it, beforeAll } from 'vitest';
import { parseScript, serializeScript } from '../../src/model/json.js';
import { encodeScript, scriptHash } from '../../src/encode/script.js';
import { decodeScript, scriptHashFromCbor, CborDecodeError } from '../../src/encode/decode.js';
import { toHex } from '../../src/encode/cbor.js';
import { loadAllVectors } from '../../src/vectors/load.js';
import type { Vector } from '../../src/vectors/schema.js';

/**
 * Scripts arrive from the chain as CBOR, not as JSON, so the decoder is what
 * makes the corpus usable against real data. These tests hold it to the one
 * property that matters: a decode followed by a re-encode in the SAME framing
 * reproduces the original bytes exactly, and therefore the original hash.
 */
let corpus: Vector[];

beforeAll(async () => {
  corpus = await loadAllVectors();
});

describe('CBOR round-trips through the decoder', () => {
  it('recovers the same script from both encodings of every vector', () => {
    const problems: string[] = [];
    for (const vector of corpus) {
      const expected = parseScript(vector.script);
      for (const encoding of ['definite', 'cardanoBinary'] as const) {
        const decoded = decodeScript(vector.encoding[encoding].cborHex);
        if (JSON.stringify(serializeScript(decoded.script)) !== JSON.stringify(vector.script)) {
          problems.push(`${vector.id} ${encoding}: decoded script differs`);
        }
        if (
          JSON.stringify(serializeScript(decoded.script)) !==
          JSON.stringify(serializeScript(expected))
        ) {
          problems.push(`${vector.id} ${encoding}: decoded script differs from parsed JSON`);
        }
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('re-encodes to the exact bytes it read', () => {
    const problems: string[] = [];
    for (const vector of corpus) {
      for (const encoding of ['definite', 'cardanoBinary'] as const) {
        const original = vector.encoding[encoding].cborHex;
        const decoded = decodeScript(original);
        const reencoded = toHex(encodeScript(decoded.script, encoding));
        if (reencoded !== original) problems.push(`${vector.id} ${encoding}: bytes changed`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('reports which framings reproduce the bytes', () => {
    for (const vector of corpus) {
      const definite = decodeScript(vector.encoding.definite.cborHex);
      const nodeSide = decodeScript(vector.encoding.cardanoBinary.cborHex);

      if (vector.encoding.encodingSensitive) {
        // The two byte strings differ, so each is reproducible by one encoding.
        expect(definite.framings, vector.id).toEqual(['definite']);
        expect(nodeSide.framings, vector.id).toEqual(['cardanoBinary']);
      } else {
        // Identical bytes, so both encodings reproduce them.
        expect(definite.framings, vector.id).toEqual(['definite', 'cardanoBinary']);
      }
      expect(definite.encodingSensitive, vector.id).toBe(vector.encoding.encodingSensitive);
    }
  });

  it('hashes received bytes without re-encoding them', () => {
    // The safe primitive: a script from the chain is hashed as it arrived,
    // because re-encoding it in the wrong framing would change its hash.
    for (const vector of corpus) {
      for (const encoding of ['definite', 'cardanoBinary'] as const) {
        expect(scriptHashFromCbor(vector.encoding[encoding].cborHex), vector.id).toBe(
          vector.encoding[encoding].scriptHash,
        );
      }
    }
  });
});

describe('the decoder detects non-standard framing', () => {
  it('reports no reproducing framing for a list framed against the rule', () => {
    // An indefinite list of two children: valid CBOR, but neither standard
    // encoder emits it. Re-encoding would change the hash, so the caller has to
    // hash the original bytes.
    const handBuilt =
      '8201' + '9f' + '8200581c' + 'aa'.repeat(28) + '8200581c' + 'bb'.repeat(28) + 'ff';
    const decoded = decodeScript(handBuilt);
    expect(decoded.script.type).toBe('all');
    expect(decoded.framings).toEqual([]);
    // The hash still exists and is well defined, over the bytes as received.
    expect(scriptHashFromCbor(handBuilt)).toMatch(/^[0-9a-f]{56}$/);
    expect(scriptHashFromCbor(handBuilt)).not.toBe(scriptHash(decoded.script, 'definite'));
  });

  it('rejects trailing bytes rather than ignoring them', () => {
    const valid = toHex(encodeScript(parseScript({ type: 'after', slot: 5 }), 'definite'));
    expect(() => decodeScript(valid + '00')).toThrow(CborDecodeError);
  });

  it('rejects a key hash that is not 28 bytes', () => {
    expect(() => decodeScript('8200' + '5802' + 'aabb')).toThrow(/28 bytes/);
  });

  it('rejects an unknown script tag', () => {
    expect(() => decodeScript('820900')).toThrow(/unknown script tag 9/);
  });
});
