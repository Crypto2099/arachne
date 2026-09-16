import { describe, expect, it } from 'vitest';
import type { Vector } from '../../../src/vectors/schema.js';
import { classifyOutcome, deriveFraming } from '../../../src/compat/classify.js';

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
});

describe('deriveFraming', () => {
  it('is undetermined with no decisive vectors', () => {
    expect(deriveFraming([{ id: 'a', status: 'agreed', matchedFraming: 'both' }])).toBe(
      'undetermined',
    );
  });

  it('follows definite when every decisive vector matches definite', () => {
    expect(
      deriveFraming([
        { id: 'a', status: 'agreed', matchedFraming: 'both' },
        { id: 'b', status: 'agreed', matchedFraming: 'definite' },
        { id: 'c', status: 'agreed', matchedFraming: 'definite' },
      ]),
    ).toBe('definite');
  });

  it('follows cardanoBinary when every decisive vector matches cardanoBinary', () => {
    expect(deriveFraming([{ id: 'a', status: 'agreed', matchedFraming: 'cardanoBinary' }])).toBe(
      'cardanoBinary',
    );
  });

  it('is mixed when decisive vectors disagree with each other', () => {
    expect(
      deriveFraming([
        { id: 'a', status: 'agreed', matchedFraming: 'definite' },
        { id: 'b', status: 'agreed', matchedFraming: 'cardanoBinary' },
      ]),
    ).toBe('mixed');
  });

  it('is undetermined when every decisive vector refused or diverged instead of matching one framing', () => {
    expect(
      deriveFraming([
        { id: 'a', status: 'refused', error: 'x' },
        { id: 'b', status: 'diverged', hash: 'z', matchedFraming: 'neither' },
      ]),
    ).toBe('undetermined');
  });
});
