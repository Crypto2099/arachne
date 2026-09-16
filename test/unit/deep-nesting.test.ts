import { describe, expect, it } from 'vitest';
import { parseScript, serializeScript, serializeScriptToJson } from '../../src/model/json.js';
import { remarksFor, shapeOf } from '../../src/model/invariants.js';
import { encodeScript, isEncodingSensitive, scriptHash } from '../../src/encode/script.js';
import { decodeScript } from '../../src/encode/decode.js';
import { toHex } from '../../src/encode/cbor.js';
import {
  evaluate,
  failingLeaves,
  formatTrace,
  type EvalNode,
} from '../../src/evaluate/evaluate.js';
import { satisfactionCases } from '../../src/vectors/build.js';
import { cosigners } from '../../src/generate/cosigners.js';
import type { NativeScript } from '../../src/model/types.js';

const [KEY] = cosigners(1) as [string];

/**
 * 5383 is the depth that matters, not a round stress number: it is the
 * deepest linear "all" whose CBOR still fits inside `maxTxSize`, 16,384
 * bytes (spec/06-chain-exercises.md), the ceiling a script delivered inline
 * in a witness set is bound by no matter which tool produced it, and
 * cardano-cli has hashed a script this deep without complaint. Anything this
 * library cannot handle at 5383 is a script the ledger would accept and this
 * would crash on. 10000 is comfortably past that ceiling, standing in for
 * "no depth the chain could ever present still breaks this".
 */
const ON_CHAIN_DEPTH = 5383;
const PAST_CEILING_DEPTH = 10000;

/**
 * A linear "all" nest `depth` levels deep, wrapping a single `sig` leaf.
 * Built with a loop, not recursion: this file exists to prove the library
 * survives depths a recursive implementation cannot, so the fixture cannot
 * be built by the technique under test either.
 */
function linearAll(depth: number, keyHash: string = KEY): NativeScript {
  let node: NativeScript = { type: 'sig', keyHash };
  for (let level = 1; level < depth; level += 1) {
    node = { type: 'all', scripts: [node] };
  }
  return node;
}

describe.each([ON_CHAIN_DEPTH, PAST_CEILING_DEPTH])('a linear "all" nest of depth %d', (depth) => {
  const script = linearAll(depth);

  it('parses the equivalent JSON without a stack overflow', () => {
    // A NativeScript already has the JSON shape for `all` and `sig`, so this
    // is valid input to `parseScript` as-is. Identity is checked by hash
    // rather than by deep equality: `toEqual` on a tree this deep recurses
    // inside the assertion library itself and overflows regardless of what
    // this library does, which is exactly why the checks below compare
    // flat, cheaply-computed values instead of whole trees.
    const parsed = parseScript(script);
    expect(toHex(encodeScript(parsed))).toBe(toHex(encodeScript(script)));
  });

  it('computes shape in one pass', () => {
    const shape = shapeOf(script);
    expect(shape.depth).toBe(depth);
    expect(shape.nodeCount).toBe(depth);
    expect(shape.sigCount).toBe(1);
    expect(shape.timelockCount).toBe(0);
    expect(shape.maxBreadth).toBe(1);
    expect(shape.containerCounts).toEqual({ all: depth - 1, any: 0, atLeast: 0 });
    expect(shape.keyHashes).toEqual([KEY]);
  });

  it('encodes and hashes deterministically', () => {
    const cbor = encodeScript(script);
    // Every level costs a fixed number of bytes (a 2-element array header and
    // tag, plus a 1-element list header), so the length is exact, not just
    // "some positive number".
    expect(cbor.length).toBe(32 + 3 * (depth - 1));
    expect(scriptHash(script)).toBe(scriptHash(script));
  });

  it('decodes back to a script with an identical hash', () => {
    const cbor = encodeScript(script);
    const decoded = decodeScript(cbor);
    expect(decoded.bytesRead).toBe(cbor.length);
    // Every list here holds exactly one child, well under the 24-child
    // threshold where the two standard encodings diverge, so both should
    // reproduce these exact bytes.
    expect(decoded.framings.sort()).toEqual(['cardanoBinary', 'definite']);
    expect(scriptHash(decoded.script)).toBe(scriptHash(script));
  });

  it('evaluates and keeps the full trace, not a flattened verdict', () => {
    const satisfied = evaluate(script, { signers: [KEY] });
    expect(satisfied.satisfied).toBe(true);
    walkSpine(satisfied.trace, depth, {
      containerReason: 'all 1 sub-scripts satisfied',
      leafSatisfied: true,
      leafReason: `signed by ${KEY.slice(0, 8)}`,
    });

    const unsatisfied = evaluate(script, { signers: [] });
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.missingSigners).toEqual([KEY]);
    walkSpine(unsatisfied.trace, depth, {
      containerReason: '1 of 1 sub-scripts unsatisfied',
      leafSatisfied: false,
      leafReason: `no witness for ${KEY.slice(0, 8)}`,
    });
  });

  it('serializes to JSON text iteratively and round-trips through parseScript', () => {
    const text = serializeScriptToJson(script);
    const roundTripped = parseScript(JSON.parse(text));
    expect(toHex(encodeScript(roundTripped))).toBe(toHex(encodeScript(script)));
  });

  it('finds no remarks and no encoding sensitivity in a well-formed nest', () => {
    expect(remarksFor(script)).toEqual([]);
    // A single child at every level never reaches the 24-child threshold
    // where the two standard CBOR encodings diverge.
    expect(isEncodingSensitive(script)).toBe(false);
  });

  it('flags an encoding-sensitive container at the bottom of a deep nest', () => {
    // 24 children is the smallest cohort where `cardano-binary` switches to
    // indefinite framing (src/encode/script.ts), so this is the shallowest
    // fixture that should trip the search regardless of how far down it sits.
    const wide: NativeScript = {
      type: 'any',
      scripts: cosigners(24).map((keyHash) => ({ type: 'sig' as const, keyHash })),
    };
    let deep: NativeScript = wide;
    for (let level = 1; level < depth; level += 1) deep = { type: 'all', scripts: [deep] };
    expect(isEncodingSensitive(deep)).toBe(true);
  });

  it('reports a remark at the bottom of a deep nest, at the right path', () => {
    const bad: NativeScript = {
      type: 'atLeast',
      required: 5,
      scripts: [{ type: 'sig', keyHash: KEY }],
    };
    let deep: NativeScript = bad;
    let path = '';
    for (let level = 1; level < depth; level += 1) {
      deep = { type: 'all', scripts: [deep] };
      path = `${path}/all[0]`;
    }
    const remarks = remarksFor(deep);
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ path, code: 'required-exceeds-children' });
  });

  it('collects the unsatisfied leaf and renders the trace as text', () => {
    const { trace } = evaluate(script, { signers: [] });
    const leaves = failingLeaves(trace);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ type: 'sig', satisfied: false });

    const text = formatTrace(trace);
    const lines = text.split('\n');
    expect(lines).toHaveLength(depth);
    expect(lines[0]).toBe('FAIL all: 1 of 1 sub-scripts unsatisfied');
    expect(lines[depth - 1]).toBe(
      `  `.repeat(depth - 1) + `FAIL sig: no witness for ${KEY.slice(0, 8)}`,
    );
  });

  it('builds satisfaction cases without walking the tree recursively', () => {
    // One key, so the exhaustive power set is signed/unsigned; no timelock,
    // so there is exactly one (unbounded) interval to probe.
    const cases = satisfactionCases(script);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.expected).sort()).toEqual([false, true]);
  });
});

/**
 * Walk an `evaluate` trace down a linear "all" spine one level at a time,
 * checking `path`, `reason` and `satisfied` at every level rather than
 * trusting a single boolean at the root. Every "all" here wraps exactly one
 * child, so this is also where a bug that only shows up after many nesting
 * levels (an off-by-one in path construction, for instance) would surface.
 */
function walkSpine(
  trace: EvalNode,
  depth: number,
  expected: { containerReason: string; leafSatisfied: boolean; leafReason: string },
): void {
  let node = trace;
  let path = '';
  for (let level = 0; level < depth - 1; level += 1) {
    expect(node.type).toBe('all');
    expect(node.path).toBe(path);
    expect(node.reason).toBe(expected.containerReason);
    expect(node.satisfied).toBe(expected.leafSatisfied);
    expect(node.children).toHaveLength(1);
    path = `${path}/all[0]`;
    node = node.children[0] as EvalNode;
  }
  expect(node.type).toBe('sig');
  expect(node.path).toBe(path);
  expect(node.satisfied).toBe(expected.leafSatisfied);
  expect(node.reason).toBe(expected.leafReason);
  expect(node.children).toHaveLength(0);
}

describe('the iterative JSON writer agrees with the recursive object form', () => {
  it('produces identical text at a depth where JSON.stringify can still run', () => {
    // JSON.stringify is recursive in V8 and throws exactly at the on-chain
    // ceiling this project cares about, so this can only be cross-checked
    // against the recursive form well below that ceiling. 500 is far past
    // anything in the generated corpus and comfortably short of where
    // JSON.stringify itself would fail.
    const script = linearAll(500);
    expect(serializeScriptToJson(script)).toBe(JSON.stringify(serializeScript(script)));
  });

  it.each([ON_CHAIN_DEPTH, PAST_CEILING_DEPTH])(
    'does not throw at depth %d, where the recursive object form cannot even be stringified',
    (depth) => {
      const script = linearAll(depth);
      expect(() => serializeScriptToJson(script)).not.toThrow();
    },
  );
});
