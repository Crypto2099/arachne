import type { NativeScript } from '../model/types.js';
import { cosigners } from './cosigners.js';

/**
 * A family is a named, parameterized generator. Families are what make the
 * corpus reviewable: a vector is reproducible from its family and parameters
 * alone, so a reviewer checks the generator once rather than reading thousands
 * of JSON files.
 *
 * Every family here targets a specific question. Adding one means naming the
 * question it answers in `question`, which becomes part of the vector and of
 * the generated index.
 */
export interface Family<P extends object = Record<string, never>> {
  name: string;
  question: string;
  /** Every parameter combination this family covers. */
  cases(): P[];
  build(params: P): NativeScript;
  /** Stable identifier for one case, unique within the family. */
  id(params: P): string;
}

const DEPTHS = [1, 2, 3, 4, 5, 8, 12, 16, 24, 32, 48, 64];

/** Linear nesting: all[all[all[... sig]]]. Where does depth stop being accepted? */
export const nestLinear: Family<{ tag: 'all' | 'any'; depth: number }> = {
  name: 'nest-linear',
  question:
    'How deeply can one container type nest before a node rejects the script or the transaction stops fitting?',
  cases: () =>
    DEPTHS.flatMap((depth) => [
      { tag: 'all' as const, depth },
      { tag: 'any' as const, depth },
    ]),
  id: ({ tag, depth }) => `${tag}-d${String(depth).padStart(3, '0')}`,
  build: ({ tag, depth }) => {
    const [key] = cosigners(1);
    let node: NativeScript = { type: 'sig', keyHash: key as string };
    for (let i = 0; i < depth; i += 1) node = { type: tag, scripts: [node] };
    return node;
  },
};

/** Alternating containers, so no implementation can collapse a run of one tag. */
export const nestAlternating: Family<{ depth: number }> = {
  name: 'nest-alternating',
  question: 'Does alternating container types change the depth at which a script stops working?',
  // From depth 2: at depth 1 there is nothing to alternate, and the result is
  // the same script nest-linear already generates.
  cases: () => DEPTHS.filter((depth) => depth >= 2).map((depth) => ({ depth })),
  id: ({ depth }) => `alt-d${String(depth).padStart(3, '0')}`,
  build: ({ depth }) => {
    const [key] = cosigners(1);
    let node: NativeScript = { type: 'sig', keyHash: key as string };
    for (let i = 0; i < depth; i += 1) {
      node = i % 2 === 0 ? { type: 'all', scripts: [node] } : { type: 'any', scripts: [node] };
    }
    return node;
  },
};

/** Wide, flat containers. Breadth costs bytes far faster than depth does. */
export const breadth: Family<{ tag: 'all' | 'any'; width: number }> = {
  name: 'breadth',
  question:
    'How many sub-scripts fit in one container before the transaction exceeds its size limit?',
  // From width 2: a container with one child is not a breadth case, and it is
  // the depth-1 script nest-linear already generates.
  cases: () =>
    [2, 3, 5, 10, 20, 50, 100, 200, 400].flatMap((width) => [
      { tag: 'all' as const, width },
      { tag: 'any' as const, width },
    ]),
  id: ({ tag, width }) => `${tag}-w${String(width).padStart(3, '0')}`,
  build: ({ tag, width }) => ({
    type: tag,
    scripts: cosigners(width).map((keyHash) => ({ type: 'sig', keyHash })),
  }),
};

/**
 * Every threshold against a fixed cohort, including the two that cannot be
 * satisfied and the one that needs no signature at all. These are well-formed
 * scripts with real hashes, not validation errors.
 */
export const thresholdMatrix: Family<{ n: number; k: number }> = {
  name: 'threshold-matrix',
  question:
    'Does every k in 0..n+1 behave as the reference evaluator says, including the degenerate ends?',
  cases: () => {
    const out: { n: number; k: number }[] = [];
    for (const n of [1, 2, 3, 5, 7]) for (let k = 0; k <= n + 1; k += 1) out.push({ n, k });
    return out;
  },
  id: ({ n, k }) => `atleast-${k}-of-${n}`,
  build: ({ n, k }) => ({
    type: 'atLeast',
    required: k,
    scripts: cosigners(n).map((keyHash) => ({ type: 'sig', keyHash })),
  }),
};

/**
 * A threshold whose cohort contains the same key twice. The reference evaluator
 * counts satisfied sub-scripts, so one signature covers two slots here. A
 * key-set implementation disagrees, which is the point of the family.
 */
export const duplicateKeys: Family<{ copies: number; k: number }> = {
  name: 'duplicate-keys',
  question: 'Does a repeated key hash under one threshold count once or once per occurrence?',
  cases: () => [
    { copies: 2, k: 2 },
    { copies: 3, k: 2 },
    { copies: 3, k: 3 },
    { copies: 2, k: 3 },
  ],
  id: ({ copies, k }) => `dup-${copies}x-need-${k}`,
  build: ({ copies, k }) => {
    const [key] = cosigners(1);
    return {
      type: 'atLeast',
      required: k,
      scripts: Array.from({ length: copies }, () => ({
        type: 'sig' as const,
        keyHash: key as string,
      })),
    };
  },
};

/** Structurally valid scripts that no witness set can satisfy, or that any can. */
export const degenerate: Family<{ shape: string }> = {
  name: 'degenerate',
  question: 'What do the empty and out-of-range containers hash to, and does a node accept them?',
  cases: () => [
    { shape: 'empty-all' },
    { shape: 'empty-any' },
    { shape: 'empty-atleast-0' },
    { shape: 'empty-atleast-1' },
    { shape: 'atleast-negative' },
    { shape: 'nested-empty-all' },
  ],
  id: ({ shape }) => shape,
  build: ({ shape }) => {
    switch (shape) {
      case 'empty-all':
        return { type: 'all', scripts: [] };
      case 'empty-any':
        return { type: 'any', scripts: [] };
      case 'empty-atleast-0':
        return { type: 'atLeast', required: 0, scripts: [] };
      case 'empty-atleast-1':
        return { type: 'atLeast', required: 1, scripts: [] };
      case 'atleast-negative':
        // `n` is int64 in the CDDL, not uint, so this is encodable. Whether a
        // node accepts it is an open question the chain exercises answer.
        return {
          type: 'atLeast',
          required: -1,
          scripts: cosigners(2).map((keyHash) => ({ type: 'sig', keyHash })),
        };
      case 'nested-empty-all':
        return { type: 'all', scripts: [{ type: 'all', scripts: [] }] };
      default:
        throw new Error(`unknown degenerate shape ${shape}`);
    }
  },
};

/**
 * Timelocks in every container position, including the combinations that bound
 * a validity interval from both ends and the one that bounds it impossibly.
 */
export const timelocks: Family<{ shape: string }> = {
  name: 'timelocks',
  question:
    'Which timelock arrangements can a transaction actually satisfy, given that an absent interval bound fails rather than passes?',
  cases: () => [
    { shape: 'after-only' },
    { shape: 'before-only' },
    { shape: 'window' },
    { shape: 'inverted-window' },
    { shape: 'sig-and-after' },
    { shape: 'sig-or-after' },
    { shape: 'any-timelock-nested' },
  ],
  id: ({ shape }) => shape,
  build: ({ shape }) => {
    const [a, b] = cosigners(2) as [string, string];
    switch (shape) {
      case 'after-only':
        return { type: 'after', slot: 1_000 };
      case 'before-only':
        return { type: 'before', slot: 9_000_000 };
      case 'window':
        return {
          type: 'all',
          scripts: [
            { type: 'after', slot: 1_000 },
            { type: 'before', slot: 9_000_000 },
          ],
        };
      case 'inverted-window':
        // Lower bound above the upper bound: no interval satisfies both.
        return {
          type: 'all',
          scripts: [
            { type: 'after', slot: 9_000_000 },
            { type: 'before', slot: 1_000 },
          ],
        };
      case 'sig-and-after':
        return {
          type: 'all',
          scripts: [
            { type: 'sig', keyHash: a },
            { type: 'after', slot: 1_000 },
          ],
        };
      case 'sig-or-after':
        return {
          type: 'any',
          scripts: [
            { type: 'sig', keyHash: a },
            { type: 'after', slot: 1_000 },
          ],
        };
      case 'any-timelock-nested':
        return {
          type: 'atLeast',
          required: 2,
          scripts: [
            { type: 'sig', keyHash: a },
            { type: 'sig', keyHash: b },
            { type: 'all', scripts: [{ type: 'after', slot: 1_000 }] },
          ],
        };
      default:
        throw new Error(`unknown timelock shape ${shape}`);
    }
  },
};

/**
 * Thresholds inside thresholds. This is the family that separates a correct
 * recursive evaluator from one that accumulates key hashes up the tree, and it
 * is the shape Ekklesia's authentication gate is most likely to meet in the
 * wild: a board of signers where one seat is itself a multisig.
 */
export const nestedThreshold: Family<{ outer: number; inner: number; k: number }> = {
  name: 'nested-threshold',
  question: 'Does a threshold nested inside another evaluate independently, or does it flatten?',
  cases: () => [
    { outer: 2, inner: 2, k: 1 },
    { outer: 2, inner: 2, k: 2 },
    { outer: 3, inner: 2, k: 2 },
    { outer: 3, inner: 3, k: 2 },
    { outer: 5, inner: 3, k: 3 },
  ],
  id: ({ outer, inner, k }) => `outer${outer}-inner${inner}-k${k}`,
  build: ({ outer, inner, k }) => {
    const leaders = cosigners(outer, 'lead');
    const delegates = cosigners(inner, 'deleg');
    return {
      type: 'atLeast',
      required: k,
      scripts: [
        ...leaders.slice(0, outer - 1).map((keyHash) => ({ type: 'sig' as const, keyHash })),
        {
          type: 'atLeast',
          required: Math.max(1, inner - 1),
          scripts: delegates.map((keyHash) => ({ type: 'sig' as const, keyHash })),
        },
      ],
    };
  },
};

/**
 * A multisig whose members are themselves multisigs, at the sizes a real
 * federation reaches.
 *
 * This is the shape that arrives when organizations that each govern themselves
 * by a threshold form a body that governs itself by a threshold. Every member
 * seat is an independent cohort with its own keys, and the top level counts
 * seats rather than signatures. It is the hardest case for an implementation
 * that flattens, because flattening turns "three of five member organizations"
 * into "all eighty-seven individuals".
 *
 * The parameters run up to a script that nearly fills a transaction on its own,
 * so the family covers the structural question and the size question together.
 */
export const federation: Family<{ members: number; cohort: number; seats: number }> = {
  name: 'federation',
  question:
    'Does a threshold over member organizations, each itself a threshold, evaluate seat by seat at the sizes a real federation reaches?',
  cases: () => [
    { members: 3, cohort: 3, seats: 2 },
    { members: 5, cohort: 3, seats: 3 },
    { members: 5, cohort: 5, seats: 3 },
    { members: 7, cohort: 5, seats: 4 },
    { members: 10, cohort: 7, seats: 6 },
    { members: 15, cohort: 10, seats: 8 },
    // Sized to approach maxTxSize on its own, so the inline ceiling is bracketed
    // by a script with a realistic shape rather than a flat list of signatures.
    { members: 20, cohort: 20, seats: 11 },
  ],
  id: ({ members, cohort, seats }) => `m${members}-c${cohort}-s${seats}`,
  build: ({ members, cohort, seats }) => ({
    type: 'atLeast',
    required: seats,
    scripts: Array.from({ length: members }, (_, m) => ({
      type: 'atLeast' as const,
      // Each member carries its own internal majority.
      required: Math.floor(cohort / 2) + 1,
      // Distinct key namespace per member: two members sharing a key would
      // change the semantics rather than the size.
      scripts: cosigners(cohort, `m${m}k`).map((keyHash) => ({
        type: 'sig' as const,
        keyHash,
      })),
    })),
  }),
};

/**
 * A federation of federations. Three levels of threshold, each with real
 * breadth, so no level can be collapsed into its parent without changing the
 * answer.
 */
export const federationOfFederations: Family<{ blocs: number; members: number; cohort: number }> = {
  name: 'federation-of-federations',
  question:
    'Does a three-level threshold hierarchy evaluate level by level, and how large is one before it stops fitting?',
  cases: () => [
    { blocs: 2, members: 2, cohort: 2 },
    { blocs: 3, members: 3, cohort: 3 },
    { blocs: 3, members: 5, cohort: 5 },
    { blocs: 5, members: 5, cohort: 5 },
  ],
  id: ({ blocs, members, cohort }) => `b${blocs}-m${members}-c${cohort}`,
  build: ({ blocs, members, cohort }) => ({
    type: 'atLeast',
    required: Math.floor(blocs / 2) + 1,
    scripts: Array.from({ length: blocs }, (_, b) => ({
      type: 'atLeast' as const,
      required: Math.floor(members / 2) + 1,
      scripts: Array.from({ length: members }, (_, m) => ({
        type: 'atLeast' as const,
        required: Math.floor(cohort / 2) + 1,
        scripts: cosigners(cohort, `b${b}m${m}k`).map((keyHash) => ({
          type: 'sig' as const,
          keyHash,
        })),
      })),
    })),
  }),
};

export const FAMILIES = [
  nestLinear,
  nestAlternating,
  breadth,
  thresholdMatrix,
  duplicateKeys,
  degenerate,
  timelocks,
  nestedThreshold,
  federation,
  federationOfFederations,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as Family<any>[];
