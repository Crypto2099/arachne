import { describe, expect, it } from 'vitest';
import type { Vector } from '../../../src/vectors/schema.js';
import {
  classifyDecodeOutcome,
  classifyOutcome,
  deriveFraming,
} from '../../../src/compat/classify.js';

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
