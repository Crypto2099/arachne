import { describe, expect, it } from 'vitest';
import {
  parseScript,
  serializeScript,
  unwrapScript,
  ScriptParseError,
} from '../../src/model/json.js';
import { remarksFor, shapeOf } from '../../src/model/invariants.js';
import { cosigners } from '../../src/generate/cosigners.js';

const [A, B] = cosigners(2) as [string, string];

describe('parsing', () => {
  it('unwraps the envelope a script arrives in from an indexer', () => {
    // Blockfrost labels a native script "timelock". The label names the script
    // language, not a script type, and is not part of what gets hashed.
    const wrapped = { type: 'timelock', value: { type: 'sig', keyHash: A } };
    expect(parseScript(unwrapScript(wrapped))).toEqual({ type: 'sig', keyHash: A });
  });

  it('rejects a key hash that is not 28 bytes', () => {
    expect(() => parseScript({ type: 'sig', keyHash: 'abcd' })).toThrow(ScriptParseError);
  });

  it('names the path to a nested failure', () => {
    const bad = { type: 'all', scripts: [{ type: 'any', scripts: [{ type: 'nope' }] }] };
    expect(() => parseScript(bad)).toThrow(/all\[0\]\/any\[0\]/);
  });

  it('accepts the degenerate shapes, because a node does', () => {
    expect(() => parseScript({ type: 'all', scripts: [] })).not.toThrow();
    expect(() => parseScript({ type: 'atLeast', required: 0, scripts: [] })).not.toThrow();
    expect(() => parseScript({ type: 'atLeast', required: 9, scripts: [] })).not.toThrow();
  });

  it('round-trips through the canonical JSON form', () => {
    const script = parseScript({
      type: 'atLeast',
      required: 1,
      scripts: [
        { type: 'sig', keyHash: A },
        { type: 'before', slot: 5 },
      ],
    });
    expect(parseScript(serializeScript(script))).toEqual(script);
  });
});

describe('shape', () => {
  it('counts a bare leaf as depth 1', () => {
    expect(shapeOf({ type: 'sig', keyHash: A }).depth).toBe(1);
    expect(shapeOf({ type: 'all', scripts: [{ type: 'sig', keyHash: A }] }).depth).toBe(2);
  });

  it('separates sig node count from distinct key count', () => {
    const shape = shapeOf({
      type: 'atLeast',
      required: 2,
      scripts: [
        { type: 'sig', keyHash: A },
        { type: 'sig', keyHash: A },
        { type: 'sig', keyHash: B },
      ],
    });
    expect(shape.sigCount).toBe(3);
    expect(shape.keyHashes).toHaveLength(2);
  });

  it('gives an empty container a level of its own', () => {
    expect(shapeOf({ type: 'all', scripts: [] }).depth).toBe(1);
    expect(shapeOf({ type: 'all', scripts: [{ type: 'all', scripts: [] }] }).depth).toBe(2);
  });
});

describe('remarks', () => {
  it('flags a threshold that can never be met', () => {
    const remarks = remarksFor({
      type: 'atLeast',
      required: 3,
      scripts: [{ type: 'sig', keyHash: A }],
    });
    expect(remarks.map((r) => r.code)).toContain('required-exceeds-children');
  });

  it('flags a duplicated key under a threshold', () => {
    const remarks = remarksFor({
      type: 'atLeast',
      required: 2,
      scripts: [
        { type: 'sig', keyHash: A },
        { type: 'sig', keyHash: A },
      ],
    });
    expect(remarks.map((r) => r.code)).toContain('duplicate-key-in-threshold');
  });

  it('reports nothing for an ordinary multisig', () => {
    expect(
      remarksFor({
        type: 'atLeast',
        required: 2,
        scripts: [
          { type: 'sig', keyHash: A },
          { type: 'sig', keyHash: B },
        ],
      }),
    ).toEqual([]);
  });
});
