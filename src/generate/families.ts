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
  // 23, 24 and 25 bracket the point where cardano-binary switches a list from
  // definite to indefinite framing, which is where the two encodings start
  // producing different script hashes.
  cases: () =>
    [2, 3, 5, 10, 20, 23, 24, 25, 50, 100, 200, 400].flatMap((width) => [
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

/**
 * The encoding boundary, reached from inside rather than at the root.
 *
 * `cardano-binary` frames each list independently, so a script whose root holds
 * two children can still diverge if one of those children holds 24. A consumer
 * that checks only the root's child count will conclude a script is safe when it
 * is not.
 */
export const encodingBoundary: Family<{ position: string; width: number }> = {
  name: 'encoding-boundary',
  question:
    'Does the definite-to-indefinite switch depend on each list independently, so a small root can still hide a divergent child?',
  cases: () =>
    ['root', 'nested', 'deep'].flatMap((position) =>
      [23, 24].map((width) => ({ position, width })),
    ),
  id: ({ position, width }) => `${position}-w${width}`,
  build: ({ position, width }) => {
    const cohort = cosigners(width, `eb${width}k`).map((keyHash) => ({
      type: 'sig' as const,
      keyHash,
    }));
    const group: NativeScript = { type: 'any', scripts: cohort };
    switch (position) {
      case 'root':
        return group;
      case 'nested':
        return {
          type: 'all',
          scripts: [{ type: 'sig', keyHash: cosigners(1, 'ebx')[0] as string }, group],
        };
      case 'deep':
        return {
          type: 'all',
          scripts: [{ type: 'all', scripts: [{ type: 'atLeast', required: 1, scripts: [group] }] }],
        };
      default:
        throw new Error(`unknown position ${position}`);
    }
  },
};

/**
 * Cardano's own constitutional committee, at the sizes and thresholds CIP-1694
 * itself uses.
 *
 * A committee member's `Yes` vote is a signature, so the committee's own
 * ratification rule is exactly an n-of-m native script: no weighting, no
 * stake, one member one vote. That makes it the one governance body in this
 * file that translates without any approximation.
 *
 * `cip1694-worked-example` is CIP-1694's own illustration of expiry, quoted
 * from the "Requirements" section of CIP-1694
 * (github.com/cardano-foundation/CIPs, CIP-1694/README.md): "a committee of
 * size five with a threshold of 60% a minimum size of three and two expired
 * members can still pass governance actions if two non-expired members vote
 * Yes". Expired members cast no vote, so the script carries only the three
 * live seats; 60% of three is 1.8, and the CIP's own arithmetic rounds that up
 * to two.
 *
 * `mainnet-genesis` is the committee actually seated at the Conway (Chang)
 * hard fork: seven members and a 2/3 threshold, read from the `committee`
 * field of mainnet's own genesis configuration
 * (book.world.dev.cardano.org/environments/mainnet/conway-genesis.json,
 * mirrored from IntersectMBO/cardano-configurations). 2/3 of seven is
 * 4.667, rounded up to five. CIP-1694 states the threshold is itself a
 * governance parameter and can be changed by a later "update committee and/or
 * threshold" action, so this is the value at genesis, not a promise it stays
 * that way.
 */
export const constitutionalCommittee: Family<{ label: string; n: number; k: number }> = {
  name: 'constitutional-committee',
  question:
    "Does Cardano's own constitutional committee threshold translate into a plain n-of-m script at the committee size actually seated, including the case where expired members are excluded from the count?",
  cases: () => [
    { label: 'cip1694-worked-example', n: 3, k: 2 },
    { label: 'mainnet-genesis', n: 7, k: 5 },
  ],
  id: ({ label }) => label,
  build: ({ label, n, k }) => ({
    type: 'atLeast',
    required: k,
    scripts: cosigners(n, `cc-${label}`).map((keyHash) => ({ type: 'sig' as const, keyHash })),
  }),
};

/**
 * Governance action ratification, as CIP-1694 actually structures it: a fixed
 * combination of governance bodies, each meeting its own published threshold,
 * conjoined rather than chosen between.
 *
 * CIP-1694's "Ratification" section states the shape directly: "always
 * involve two of the three governance bodies, with the exception of a
 * hard-fork initiation and security-relevant protocol parameters, which
 * requires ratification by all governance bodies", and "an action will thus
 * be ratified when a combination of the following occurs" - a conjunction,
 * not a choice. Which two or three bodies apply, per action, is CIP-1694's
 * own table in the "Requirements" section.
 *
 * The threshold ratios are read from mainnet's own genesis configuration
 * (book.world.dev.cardano.org/environments/mainnet/conway-genesis.json,
 * `dRepVotingThresholds`, `poolVotingThresholds` and `committee.threshold`),
 * the values actually in force after the Conway (Chang) hard fork. Every
 * threshold here is a governance parameter in its own right and can be
 * changed by a later protocol-parameter-change action; this family records
 * the values at genesis, not an assumption that they hold indefinitely.
 *
 * The committee cohort is Cardano's real size: seven members
 * (`committeeMinSize`, matching the seven entries in `committee.members`).
 * DReps and SPOs are not size-bounded in reality and their thresholds are
 * shares of stake, not of headcount; representing either faithfully would
 * need real stake weights this corpus does not have and cannot fabricate. So
 * the DRep and SPO cohorts here are a fixed, illustrative headcount (15 and
 * 10), and the published percentage is applied to that headcount by rounding
 * up to the next whole member, the same "at least this fraction" reading
 * CIP-1694 itself uses for stake. What is real is the ratio and which bodies
 * a given action requires; the cohort size standing in for "every DRep" or
 * "every stake pool" is not.
 */
export const conwayRatification: Family<{
  action: string;
  cc?: { n: number; k: number };
  drep: { n: number; k: number };
  spo?: { n: number; k: number };
}> = {
  name: 'conway-ratification',
  question:
    "Does a governance action's real ratification rule, conjoining a small fixed committee with one or two much larger bodies at Cardano's own published threshold ratios, evaluate seat by seat and body by body rather than collapsing into one count?",
  cases: () => [
    // DReps 0.67 of 15 = 10.05, up to 11. SPOs 0.51 of 10 = 5.1, up to 6. No
    // committee vote on a motion against the committee itself.
    { action: 'motion-of-no-confidence', drep: { n: 15, k: 11 }, spo: { n: 10, k: 6 } },
    // Committee 2/3 of 7 = 4.667, up to 5. DReps `updateToConstitution`
    // 0.75 of 15 = 11.25, up to 12. SPOs do not vote on the constitution.
    { action: 'update-constitution', cc: { n: 7, k: 5 }, drep: { n: 15, k: 12 } },
    // Committee 5 of 7, as above. DReps `treasuryWithdrawal` 0.67 of 15,
    // same 11 as the no-confidence case above by coincidence of the ratio.
    { action: 'treasury-withdrawal', cc: { n: 7, k: 5 }, drep: { n: 15, k: 11 } },
    // The one action type all three bodies vote on. Committee 5 of 7. DReps
    // `hardForkInitiation` 0.6 of 15 = 9 exactly. SPOs 0.51 of 10, up to 6.
    {
      action: 'hard-fork-initiation',
      cc: { n: 7, k: 5 },
      drep: { n: 15, k: 9 },
      spo: { n: 10, k: 6 },
    },
    // CIP-1694 sets every threshold for the Info action to 100%, "since
    // setting it any lower would result in not being able to poll above the
    // threshold". Unanimous across all three bodies.
    {
      action: 'info',
      cc: { n: 7, k: 7 },
      drep: { n: 15, k: 15 },
      spo: { n: 10, k: 10 },
    },
  ],
  id: ({ action }) => action,
  build: ({ action, cc, drep, spo }) => {
    const cohort = (label: string, n: number, k: number): NativeScript => ({
      type: 'atLeast',
      required: k,
      scripts: cosigners(n, `${label}-${action}`).map((keyHash) => ({
        type: 'sig' as const,
        keyHash,
      })),
    });
    const bodies: NativeScript[] = [];
    if (cc) bodies.push(cohort('gcc', cc.n, cc.k));
    bodies.push(cohort('gdrep', drep.n, drep.k));
    if (spo) bodies.push(cohort('gspo', spo.n, spo.k));
    return { type: 'all', scripts: bodies };
  },
};

/**
 * The UN Security Council's veto, which is the clearest published example of
 * a member whose vote counts for more than one: a permanent member's
 * concurrence is required independently of, and in addition to, the ordinary
 * count it also contributes to.
 *
 * Article 23 of the UN Charter fixes the Council at fifteen members, five of
 * them permanent. Article 27 gives two different rules over that same
 * fifteen: "Decisions of the Security Council on procedural matters shall be
 * made by an affirmative vote of nine members", while "Decisions ... on all
 * other matters shall be made by an affirmative vote of nine members
 * including the concurring votes of the permanent members" (text read from
 * the UN's own published Charter, un.org/en/about-us/un-charter/chapter-5;
 * the article was amended in 1965 to raise Council membership from eleven to
 * fifteen and the vote from seven to nine, and this is the text currently in
 * force).
 *
 * `substantive` requires the permanent members' key hashes to appear twice:
 * once inside the pooled nine-of-fifteen count, and again in a separate
 * all-of-five branch. One permanent member's signature satisfies both at
 * once, which is exactly the sub-script-counting rule in
 * spec/03-satisfaction.md, applied to a real veto rather than an abstract
 * one.
 */
export const unSecurityCouncil: Family<{ shape: 'procedural' | 'substantive' }> = {
  name: 'un-security-council',
  question:
    "Does the Security Council's veto evaluate correctly when the same five permanent members' signatures are required both individually and as part of the pooled nine-of-fifteen count?",
  cases: () => [{ shape: 'procedural' }, { shape: 'substantive' }],
  id: ({ shape }) => shape,
  build: ({ shape }) => {
    const permanent = cosigners(5, 'unsc-permanent');
    const elected = cosigners(10, 'unsc-elected');
    const pool: NativeScript[] = [...permanent, ...elected].map((keyHash) => ({
      type: 'sig' as const,
      keyHash,
    }));
    const nineOfFifteen: NativeScript = { type: 'atLeast', required: 9, scripts: pool };
    if (shape === 'procedural') return nineOfFifteen;
    return {
      type: 'all',
      scripts: [
        nineOfFifteen,
        {
          type: 'all',
          scripts: permanent.map((keyHash) => ({ type: 'sig' as const, keyHash })),
        },
      ],
    };
  },
};

/**
 * Weighted voting, modeled the only way a native script can express it: a
 * holder with several votes signs once, and that one signature has to satisfy
 * several sub-scripts at once. This is the same rule `duplicate-keys` proves
 * with one key duplicated under one threshold; this family applies it to
 * several different holders with different weights at once, which is the
 * shape that actually arises when voting power is proportional to holdings.
 *
 * The mechanism is real and general rather than tied to one organization:
 * 8 Del. C. section 212(a), read from delcode.delaware.gov/title8/c001/sc07,
 * states the default for a stock corporation directly: "Unless otherwise
 * provided in the certificate of incorporation ... each stockholder shall be
 * entitled to 1 vote for each share of capital stock held by such
 * stockholder." The holdings below are this corpus's own small illustrative
 * numbers, chosen only to keep the sub-script count reviewable while
 * preserving the qualitative relationship each case is named for (a
 * plurality short of a majority, a majority by the narrowest possible
 * margin, three near-equal holders); they are not any named company's
 * capitalization table.
 *
 * `quorum-floor` and `majority` apply two different real rules to the same
 * three-way, near-equal cohort. 8 Del. C. section 216 fixes the statutory
 * minimum quorum at one third of the shares entitled to vote, and separately
 * sets the default vote required to act, absent a charter provision
 * otherwise, at a majority of the shares represented. A native script has no
 * "present but not voting" state, so the two thresholds are evaluated over
 * the same yes-signers here rather than reproducing the statute's two-step
 * present-then-vote procedure; what the pair of cases demonstrates is that
 * the quorum floor and the default approval bar are different numbers over
 * one cohort, which is the shape a corpus for "quorum differs from
 * supermajority" needs, at cited figures rather than invented ones.
 */
export const weightedVoting: Family<{ distribution: number[]; rule: 'majority' | 'quorum-floor' }> =
  {
    name: 'weighted-voting',
    question:
      'When a holder with several votes is modeled as several copies of one key hash, does the reference evaluator sum weight across holders correctly, and does a statutory quorum floor evaluate differently from the default majority-to-pass threshold over the same cohort?',
    cases: () => [
      // A plurality holder (4 of 10) short of a majority: no two of the
      // smaller holders are needed if the largest one finds one ally.
      { distribution: [4, 2, 2, 2], rule: 'majority' },
      // A majority by the smallest possible margin: the 6-share holder can
      // act alone, the 5-share holder never can.
      { distribution: [6, 5], rule: 'majority' },
      // Three near-equal holders, no single majority.
      { distribution: [4, 3, 3], rule: 'majority' },
      // Same three holders, the statutory quorum floor instead of the
      // majority: the 4-share holder alone already clears one third of 10.
      { distribution: [4, 3, 3], rule: 'quorum-floor' },
    ],
    id: ({ distribution, rule }) => `${distribution.join('-')}-${rule}`,
    build: ({ distribution, rule }) => {
      const total = distribution.reduce((sum, shares) => sum + shares, 0);
      const holders = cosigners(distribution.length, `sh${distribution.join('-')}`);
      const scripts: NativeScript[] = [];
      distribution.forEach((shares, i) => {
        const keyHash = holders[i] as string;
        for (let s = 0; s < shares; s += 1) scripts.push({ type: 'sig', keyHash });
      });
      // Majority: strictly more than half the shares, the default under 8 Del.
      // C. section 216(2) absent a charter provision otherwise. Quorum floor:
      // one third, the statutory minimum under section 216 that no
      // certificate or bylaw may set lower.
      const required = rule === 'majority' ? Math.floor(total / 2) + 1 : Math.ceil(total / 3);
      return { type: 'atLeast', required, scripts };
    },
  };

const EMERGENCY_DELAY_SLOT = 5_000_000;

/**
 * A generic multisig treasury pattern, not a published rule of any named
 * organization: ordinary spending needs a threshold of the full board, and a
 * smaller emergency cohort can act alone if the board cannot be assembled,
 * but only once a delay has passed. The delay is what turns "a smaller group
 * can also authorize this" into an emergency path rather than a second,
 * quieter way to spend at any time: it forces the wait to be visible on-chain
 * before the emergency branch becomes usable at all, which is the same
 * absent-bound-fails rule spec/03-satisfaction.md documents, applied to a
 * board-plus-recovery shape instead of a single key.
 *
 * This is explicitly a generic structure per the project's own rule against
 * attributing an invented number to a real organization: no specific
 * board size, emergency cohort size or delay below is any published treasury's
 * actual configuration. What the family demonstrates is the shape combining
 * a body threshold, a smaller body threshold and a timelock, which
 * `timelocks` does not: every case there gates a single signature, not a
 * multi-member board.
 */
export const treasuryEmergencyPath: Family<{
  boardSize: number;
  boardK: number;
  emergencySize: number;
  emergencyK: number;
}> = {
  name: 'treasury-emergency-path',
  question:
    'Does a normal board threshold and a smaller emergency cohort gated by a time delay evaluate independently, the way a board-plus-recovery treasury script needs both branches to?',
  cases: () => [
    { boardSize: 5, boardK: 3, emergencySize: 3, emergencyK: 2 },
    { boardSize: 7, boardK: 4, emergencySize: 2, emergencyK: 1 },
    { boardSize: 3, boardK: 2, emergencySize: 5, emergencyK: 3 },
  ],
  id: ({ boardSize, boardK, emergencySize, emergencyK }) =>
    `board${boardSize}-of-${boardK}-emergency${emergencySize}-of-${emergencyK}`,
  build: ({ boardSize, boardK, emergencySize, emergencyK }) => {
    const board = cosigners(boardSize, `board${boardSize}-${boardK}`);
    const emergency = cosigners(emergencySize, `emerg${emergencySize}-${emergencyK}`);
    return {
      type: 'any',
      scripts: [
        {
          type: 'atLeast',
          required: boardK,
          scripts: board.map((keyHash) => ({ type: 'sig' as const, keyHash })),
        },
        {
          type: 'all',
          scripts: [
            {
              type: 'atLeast',
              required: emergencyK,
              scripts: emergency.map((keyHash) => ({ type: 'sig' as const, keyHash })),
            },
            { type: 'after', slot: EMERGENCY_DELAY_SLOT },
          ],
        },
      ],
    };
  },
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
  encodingBoundary,
  constitutionalCommittee,
  conwayRatification,
  unSecurityCouncil,
  weightedVoting,
  treasuryEmergencyPath,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as Family<any>[];
