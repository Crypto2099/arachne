import { serializeScript } from '../model/json.js';
import { remarksFor, shapeOf } from '../model/invariants.js';
import type { NativeScript } from '../model/types.js';
import { encodeScript, hashPreimage, scriptHash, blake2b224 } from '../encode/script.js';
import { toHex } from '../encode/cbor.js';
import {
  baseAddressScriptStake,
  enterpriseAddress,
  govIdCip105,
  govIdCip129,
  rewardAddress,
  type Network,
} from '../encode/credential.js';
import { evaluate } from '../evaluate/evaluate.js';
import type { Family } from '../generate/families.js';
import {
  VECTOR_FORMAT_VERSION,
  type CorpusIndex,
  type SatisfactionCase,
  type Vector,
} from './schema.js';

const TESTNETS: Network[] = ['preview', 'preprod'];
const ALL_NETWORKS: Network[] = ['mainnet', 'preview', 'preprod'];

/**
 * Enumerating every witness set is exponential in the key count, so above this
 * many distinct keys the builder samples deliberately chosen sets instead of
 * the full power set. Six keys is 64 cases, which is still cheap; seven is the
 * point where a wide family starts dominating the corpus.
 */
const EXHAUSTIVE_KEY_LIMIT = 6;

/**
 * Slot offsets probed around every timelock boundary. A timelock bug almost
 * always lives exactly on the boundary, so each slot in a script contributes a
 * case one below, one on, and one above it.
 */
const BOUNDARY_OFFSETS = [-1, 0, 1];

export function buildVector<P extends object>(family: Family<P>, params: P): Vector {
  const script = family.build(params);
  const cbor = encodeScript(script);
  const hash = scriptHash(script);

  return {
    formatVersion: VECTOR_FORMAT_VERSION,
    id: `${family.name}/${family.id(params)}`,
    family: family.name,
    question: family.question,
    params: params as Record<string, unknown>,
    script: serializeScript(script),
    shape: shapeOf(script),
    remarks: remarksFor(script),
    encoding: {
      cborHex: toHex(cbor),
      preimageHex: toHex(hashPreimage(script)),
      scriptHash: hash,
      cborBytes: cbor.length,
    },
    credentials: {
      enterprise: fromNetworks(ALL_NETWORKS, (n) => enterpriseAddress(hash, n)),
      baseScriptStake: fromNetworks(ALL_NETWORKS, (n) => baseAddressScriptStake(hash, hash, n)),
      reward: fromNetworks(ALL_NETWORKS, (n) => rewardAddress(hash, n)),
      governance: {
        drep: { cip129: govIdCip129(hash, 'drep'), cip105: govIdCip105(hash, 'drep') },
        ccCold: { cip129: govIdCip129(hash, 'ccCold'), cip105: govIdCip105(hash, 'ccCold') },
        ccHot: { cip129: govIdCip129(hash, 'ccHot'), cip105: govIdCip105(hash, 'ccHot') },
      },
    },
    satisfaction: satisfactionCases(script),
    onchain: [],
  };
}

function fromNetworks(networks: Network[], make: (n: Network) => string) {
  return Object.fromEntries(networks.map((n) => [n, make(n)]));
}

/**
 * Build the witness sets worth asking about for one script, then record what
 * the reference evaluator says for each.
 *
 * `expected` here is the reference implementation's answer. It is a claim about
 * the ledger, and the chain exercises are what test the claim. Nothing in this
 * function has any authority over a real node.
 */
export function satisfactionCases(script: NativeScript): SatisfactionCase[] {
  const { keyHashes } = shapeOf(script);
  const signerSets = enumerateSignerSets(script, keyHashes);
  const intervals = enumerateIntervals(script);

  const cases: SatisfactionCase[] = [];
  for (const signers of signerSets) {
    for (const interval of intervals) {
      const context = {
        signers,
        ...(interval.start === undefined ? {} : { validityStart: interval.start }),
        ...(interval.end === undefined ? {} : { validityEnd: interval.end }),
      };
      const result = evaluate(script, context);
      cases.push({
        id: `${signerLabel(signers, keyHashes)}@${interval.label}`,
        signers,
        ...(interval.start === undefined ? {} : { validityStart: interval.start }),
        ...(interval.end === undefined ? {} : { validityEnd: interval.end }),
        expected: result.satisfied,
        expectedReason: result.trace.reason,
      });
    }
  }
  return cases;
}

function enumerateSignerSets(script: NativeScript, keys: string[]): string[][] {
  if (keys.length === 0) return [[]];

  if (keys.length <= EXHAUSTIVE_KEY_LIMIT) {
    const sets: string[][] = [];
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      sets.push(keys.filter((_, i) => (mask & (1 << i)) !== 0));
    }
    return sets;
  }

  // Above the limit the power set is unusable, and sweeping every prefix is
  // mostly redundant: for a flat container, cardinality 200 tells you nothing
  // that cardinality 3 did not. What is NOT redundant is a cardinality that
  // steps across a threshold, so the sampled sizes are derived from the
  // `required` values actually present in the script rather than from a range.
  const sizes = new Set<number>([0, 1, keys.length - 1, keys.length]);
  for (const required of collectThresholds(script)) {
    for (const offset of [-1, 0, 1]) {
      const size = required + offset;
      if (size >= 0 && size <= keys.length) sizes.add(size);
    }
  }

  const sets: string[][] = [];
  for (const size of [...sizes].sort((a, b) => a - b)) {
    // A prefix and a suffix of the same size, because a positional bug in a
    // consumer shows up as one passing and the other failing.
    sets.push(keys.slice(0, size));
    if (size > 0 && size < keys.length) sets.push(keys.slice(keys.length - size));
  }
  return dedupeSets(sets);
}

function collectThresholds(script: NativeScript): number[] {
  const found = new Set<number>();
  const walk = (node: NativeScript): void => {
    if (node.type === 'atLeast') {
      found.add(node.required);
      node.scripts.forEach(walk);
    } else if (node.type === 'all' || node.type === 'any') {
      // An "all" is a threshold of n and an "any" a threshold of 1, so both
      // have a boundary worth probing.
      found.add(node.type === 'all' ? node.scripts.length : 1);
      node.scripts.forEach(walk);
    }
  };
  walk(script);
  return [...found];
}

function dedupeSets(sets: string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const set of sets) {
    const sorted = [...set].sort();
    seen.set(sorted.join(','), sorted);
  }
  return [...seen.values()];
}

interface Interval {
  label: string;
  start?: number;
  end?: number;
}

/**
 * Validity intervals worth probing. Always includes the unbounded case, because
 * an unbounded transaction fails every timelock and that is the case most
 * likely to be wrong in a consumer.
 */
function enumerateIntervals(script: NativeScript): Interval[] {
  const slots = collectSlots(script);
  if (slots.length === 0) return [{ label: 'unbounded' }];

  const probes = new Set<number>();
  for (const slot of slots) {
    for (const offset of BOUNDARY_OFFSETS) {
      const probe = slot + offset;
      if (probe >= 0) probes.add(probe);
    }
  }

  const intervals: Interval[] = [{ label: 'unbounded' }];
  for (const probe of [...probes].sort((a, b) => a - b)) {
    intervals.push({ label: `start${probe}`, start: probe });
    intervals.push({ label: `end${probe}`, end: probe });
    intervals.push({ label: `span${probe}`, start: probe, end: probe });
  }
  return intervals;
}

function collectSlots(script: NativeScript): number[] {
  const slots = new Set<number>();
  const walk = (node: NativeScript): void => {
    if (node.type === 'after' || node.type === 'before') slots.add(node.slot);
    else if (node.type !== 'sig') node.scripts.forEach(walk);
  };
  walk(script);
  return [...slots].sort((a, b) => a - b);
}

function signerLabel(signers: string[], keys: string[]): string {
  if (signers.length === 0) return 'none';
  if (signers.length === keys.length) return 'all';
  return signers.map((s) => String(keys.indexOf(s))).join('+');
}

/** Digest over ids and script hashes. A corpus that changed shows one differing line. */
export function corpusDigest(vectors: Vector[]): string {
  const material = vectors
    .map((v) => `${v.id}\t${v.encoding.scriptHash}`)
    .sort()
    .join('\n');
  return toHex(blake2b224(new TextEncoder().encode(material)));
}

export function buildIndex(vectors: Vector[], generator: string): CorpusIndex {
  const byFamily = new Map<string, { question: string; count: number }>();
  for (const v of vectors) {
    const entry = byFamily.get(v.family) ?? { question: v.question, count: 0 };
    entry.count += 1;
    byFamily.set(v.family, entry);
  }

  return {
    formatVersion: VECTOR_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    generator,
    families: [...byFamily.entries()].map(([name, e]) => ({
      name,
      question: e.question,
      count: e.count,
    })),
    vectorCount: vectors.length,
    satisfactionCaseCount: vectors.reduce((n, v) => n + v.satisfaction.length, 0),
    observationCount: vectors.reduce((n, v) => n + v.onchain.length, 0),
    digest: corpusDigest(vectors),
    vectors: vectors
      .map((v) => ({
        id: v.id,
        family: v.family,
        path: `${v.id}.json`,
        scriptHash: v.encoding.scriptHash,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export { TESTNETS };
