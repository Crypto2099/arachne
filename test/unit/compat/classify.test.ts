import { describe, expect, it } from 'vitest';
import type { Vector } from '../../../src/vectors/schema.js';
import {
  classifyDecodeOutcome,
  classifyObservedOutcome,
  classifyOutcome,
  deriveFraming,
} from '../../../src/compat/classify.js';
import type { ObservedCase } from '../../../src/compat/corpus.js';

function fixture(id: string, definiteHash: string, cardanoBinaryHash: string): Vector {
  return {
    id,
    encoding: {
      definite: { scriptHash: definiteHash },
      cardanoBinary: { scriptHash: cardanoBinaryHash },
    },
  } as unknown as Vector;
}

const SAME = fixture('breadth/w3', 'aaaa', 'aaaa');
const SPLIT = fixture('encoding-boundary/root-w24', 'definitehash', 'cardanobinaryhash');

describe('classifyOutcome', () => {
  it('agrees, matching both, when the two encodings coincide and the tool matches them', () => {
    const result = classifyOutcome(SAME, { status: 'ok', hash: 'AAAA' });
    expect(result).toEqual({
      id: 'breadth/w3',
      status: 'agreed',
      hash: 'AAAA',
      matchedFraming: 'both',
    });
  });

  // Neither encoding is canonical (spec/07), so matching only the
  // cardanoBinary hash on an encoding-sensitive vector is still "agreed", not
  // a lesser outcome than matching "definite" would be.
  it('agrees, matching cardanoBinary, on an encoding-sensitive vector', () => {
    const result = classifyOutcome(SPLIT, { status: 'ok', hash: 'CardanoBinaryHash' });
    expect(result.status).toBe('agreed');
    expect(result.matchedFraming).toBe('cardanoBinary');
  });

  it('agrees, matching definite, on an encoding-sensitive vector', () => {
    const result = classifyOutcome(SPLIT, { status: 'ok', hash: 'DefiniteHash' });
    expect(result.status).toBe('agreed');
    expect(result.matchedFraming).toBe('definite');
  });

  it('diverges when the hash matches neither recorded encoding', () => {
    const result = classifyOutcome(SPLIT, { status: 'ok', hash: 'somethingelse' });
    expect(result.status).toBe('diverged');
    expect(result.matchedFraming).toBe('neither');
  });

  it('carries a refusal through verbatim', () => {
    const result = classifyOutcome(SAME, {
      status: 'refused',
      error: 'tool said no, exactly like this',
    });
    expect(result).toEqual({
      id: 'breadth/w3',
      status: 'refused',
      error: 'tool said no, exactly like this',
    });
  });

  it('carries an unsupported outcome verbatim', () => {
    const result = classifyOutcome(SAME, {
      status: 'unsupported',
      error: 'no builder for this shape',
    });
    expect(result.status).toBe('unsupported');
    expect(result.error).toBe('no builder for this shape');
  });

  // Only the decode path feeds a tool one specific encoding at a time, so
  // only it needs to say which one a given answer is about. Omitting the
  // third argument (every construct-path call site) must not add the field
  // at all, not set it to undefined, so a construct result stays identical to
  // one produced before decode existed.
  it('omits inputFraming entirely when not given one', () => {
    const result = classifyOutcome(SAME, { status: 'ok', hash: 'AAAA' });
    expect('inputFraming' in result).toBe(false);
  });

  it('carries inputFraming through on an ok outcome', () => {
    const result = classifyOutcome(SPLIT, { status: 'ok', hash: 'DefiniteHash' }, 'definite');
    expect(result.inputFraming).toBe('definite');
  });

  it('carries inputFraming through on a refusal too', () => {
    const result = classifyOutcome(SAME, { status: 'refused', error: 'no' }, 'cardanoBinary');
    expect(result.inputFraming).toBe('cardanoBinary');
  });
});

describe('classifyDecodeOutcome', () => {
  it('asks two questions for one vector, one per encoding', () => {
    const results = classifyDecodeOutcome(SPLIT, {
      definite: { status: 'ok', hash: 'DefiniteHash' },
      cardanoBinary: { status: 'ok', hash: 'CardanoBinaryHash' },
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'encoding-boundary/root-w24',
      inputFraming: 'definite',
      matchedFraming: 'definite',
      status: 'agreed',
    });
    expect(results[1]).toMatchObject({
      id: 'encoding-boundary/root-w24',
      inputFraming: 'cardanoBinary',
      matchedFraming: 'cardanoBinary',
      status: 'agreed',
    });
  });
});

describe('deriveFraming on construct', () => {
  it('is undetermined with no decisive vectors', () => {
    expect(
      deriveFraming([{ id: 'a', status: 'agreed', matchedFraming: 'both' }], 'construct'),
    ).toBe('undetermined');
  });

  it('follows definite when every decisive vector matches definite', () => {
    expect(
      deriveFraming(
        [
          { id: 'a', status: 'agreed', matchedFraming: 'both' },
          { id: 'b', status: 'agreed', matchedFraming: 'definite' },
          { id: 'c', status: 'agreed', matchedFraming: 'definite' },
        ],
        'construct',
      ),
    ).toBe('definite');
  });

  it('follows cardanoBinary when every decisive vector matches cardanoBinary', () => {
    expect(
      deriveFraming([{ id: 'a', status: 'agreed', matchedFraming: 'cardanoBinary' }], 'construct'),
    ).toBe('cardanoBinary');
  });

  it('is mixed when decisive vectors disagree with each other', () => {
    expect(
      deriveFraming(
        [
          { id: 'a', status: 'agreed', matchedFraming: 'definite' },
          { id: 'b', status: 'agreed', matchedFraming: 'cardanoBinary' },
        ],
        'construct',
      ),
    ).toBe('mixed');
  });

  it('is undetermined when every decisive vector refused or diverged instead of matching one framing', () => {
    expect(
      deriveFraming(
        [
          { id: 'a', status: 'refused', error: 'x' },
          { id: 'b', status: 'diverged', hash: 'z', matchedFraming: 'neither' },
        ],
        'construct',
      ),
    ).toBe('undetermined');
  });
});

describe('deriveFraming on decode', () => {
  // This is the case gouroboros's decode path demonstrates: the hash matches
  // whichever encoding was actually fed in, not a single framing regardless
  // of input. Only decode can produce this classification, because construct
  // only ever asks one question per vector and has no "input" to compare
  // against.
  it('is framing-preserving when every decisive answer matches the encoding it was fed', () => {
    expect(
      deriveFraming(
        [
          { id: 'a', status: 'agreed', matchedFraming: 'both', inputFraming: 'definite' },
          { id: 'b', status: 'agreed', matchedFraming: 'definite', inputFraming: 'definite' },
          {
            id: 'b',
            status: 'agreed',
            matchedFraming: 'cardanoBinary',
            inputFraming: 'cardanoBinary',
          },
        ],
        'decode',
      ),
    ).toBe('framing-preserving');
  });

  // A decoder that always re-encodes toward one framing regardless of which
  // bytes it was handed is the same finding as a construct-path tool that
  // only ever produces that framing, so it gets the same label rather than a
  // decode-specific one.
  it('follows definite when decode always normalizes to definite regardless of input', () => {
    expect(
      deriveFraming(
        [
          { id: 'b', status: 'agreed', matchedFraming: 'definite', inputFraming: 'definite' },
          { id: 'b', status: 'agreed', matchedFraming: 'definite', inputFraming: 'cardanoBinary' },
        ],
        'decode',
      ),
    ).toBe('definite');
  });

  it('is mixed when decode neither preserves the input nor normalizes to one framing', () => {
    expect(
      deriveFraming(
        [
          { id: 'b', status: 'agreed', matchedFraming: 'cardanoBinary', inputFraming: 'definite' },
          { id: 'b', status: 'agreed', matchedFraming: 'definite', inputFraming: 'cardanoBinary' },
        ],
        'decode',
      ),
    ).toBe('mixed');
  });
});

/**
 * An observed script, as `loadObservedCorpus` builds one: the bytes a
 * transaction carried, the hash those bytes have, and the hash each standard
 * encoder would produce from the script they decode to.
 */
function observed(overrides: Partial<ObservedCase> = {}): ObservedCase {
  return {
    id: 'observedhash',
    cborHex: '8200581c00',
    observedHash: 'observedhash',
    definiteHash: 'observedhash',
    cardanoBinaryHash: 'observedhash',
    framings: ['definite', 'cardanoBinary'],
    decodable: true,
    ...overrides,
  };
}

describe('classifyObservedOutcome', () => {
  it('agrees when the hash is the one those exact bytes have', () => {
    const result = classifyObservedOutcome(observed(), { status: 'ok', hash: 'ObservedHash' });
    expect(result.status).toBe('agreed');
    expect(result.matchedFraming).toBe('both');
  });

  // The rule that makes this path stricter than the vector decode path. A
  // vector exists in both encodings, so matching either is agreement. These
  // bytes exist on a chain in one encoding, and a tool returning the other
  // one's hash has re-framed a live script: it would compute an address that
  // holds no funds. Recorded as a divergence even though the hash it produced
  // is a perfectly valid hash of the same logical script.
  it('diverges when the hash is the other framing of the same script', () => {
    const result = classifyObservedOutcome(
      observed({
        observedHash: 'cardanobinaryhash',
        definiteHash: 'definitehash',
        cardanoBinaryHash: 'cardanobinaryhash',
        framings: ['cardanoBinary'],
      }),
      { status: 'ok', hash: 'definitehash' },
    );
    expect(result.status).toBe('diverged');
    expect(result.matchedFraming).toBe('definite');
    expect(result.inputFraming).toBe('cardanoBinary');
  });

  // `inputFraming` is what `deriveFraming` compares against, and it is only
  // knowable when one encoder reproduces the bytes. Where both do, the bytes
  // are the same either way and the answer says nothing about which rule the
  // tool follows, so the field is absent rather than guessed.
  it('records no input framing when both encoders reproduce the bytes', () => {
    expect(
      classifyObservedOutcome(observed(), { status: 'ok', hash: 'observedhash' }).inputFraming,
    ).toBeUndefined();
  });

  // `d66ed8e0` on preprod: `before(2^64-1)`, accepted by a node and not
  // decodable here, so there is no script to re-encode and no comparison hash
  // either way. The right answer is still the right answer; it just cannot be
  // attributed to a framing.
  it('agrees with no framing attributed when the bytes cannot be decoded', () => {
    const result = classifyObservedOutcome(
      {
        id: 'observedhash',
        cborHex: '8202821a0000000082051bffffffffffffffff',
        observedHash: 'observedhash',
        framings: [],
        decodable: false,
      },
      { status: 'ok', hash: 'observedhash' },
    );
    expect(result.status).toBe('agreed');
    expect(result.matchedFraming).toBe('neither');
  });

  it('carries a refusal through verbatim', () => {
    expect(
      classifyObservedOutcome(observed(), {
        status: 'refused',
        error: 'Maximum call stack size exceeded',
      }),
    ).toEqual({
      id: 'observedhash',
      status: 'refused',
      error: 'Maximum call stack size exceeded',
    });
  });
});

describe('deriveFraming on decode-onchain', () => {
  // The same rule the vector decode path uses, against observed bytes: this
  // is what cardano-sdk-core scores on the committed observed set, where four
  // scripts arrived framed cardanoBinary and one definite.
  it('is framing-preserving when every decisive answer matches the framing of the bytes it was handed', () => {
    expect(
      deriveFraming(
        [
          { id: 'a', status: 'agreed', matchedFraming: 'both' },
          {
            id: 'b',
            status: 'agreed',
            matchedFraming: 'cardanoBinary',
            inputFraming: 'cardanoBinary',
          },
          { id: 'c', status: 'agreed', matchedFraming: 'definite', inputFraming: 'definite' },
        ],
        'decode-onchain',
      ),
    ).toBe('framing-preserving');
  });

  it('follows definite when every observed script is re-encoded to definite', () => {
    expect(
      deriveFraming(
        [
          {
            id: 'b',
            status: 'diverged',
            matchedFraming: 'definite',
            inputFraming: 'cardanoBinary',
          },
          { id: 'c', status: 'agreed', matchedFraming: 'definite', inputFraming: 'definite' },
        ],
        'decode-onchain',
      ),
    ).toBe('definite');
  });
});
