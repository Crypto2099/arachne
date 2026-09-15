import type { ScriptRemark, ScriptShape } from '../model/invariants.js';
import type { Network } from '../encode/credential.js';

/** Bumped whenever the vector file shape changes in a way a consumer must notice. */
export const VECTOR_FORMAT_VERSION = 1;

export interface SatisfactionCase {
  id: string;
  /** Key hashes with a vkey witness, lowercase hex. */
  signers: string[];
  /** Transaction `invalid_before`. Omitted means the transaction sets no lower bound. */
  validityStart?: number;
  /** Transaction `invalid_hereafter`. Omitted means the transaction sets no upper bound. */
  validityEnd?: number;
  /** What the reference evaluator returns. See `onchain` for what a node did. */
  expected: boolean;
  /** The root node's reason, carried so a failing port gets a readable diff. */
  expectedReason: string;
}

export type CredentialRole =
  | 'paymentEnterprise'
  | 'paymentAndStake'
  | 'stake'
  | 'drep'
  | 'ccCold'
  | 'ccHot';

export interface VectorCredentials {
  /** CIP-19 type 7, script payment credential, no staking. */
  enterprise: Partial<Record<Network, string>>;
  /** CIP-19 type 3, the same script governing payment and staking. */
  baseScriptStake: Partial<Record<Network, string>>;
  /** CIP-19 type 15, reward address over a script stake credential. */
  reward: Partial<Record<Network, string>>;
  /** CIP-129 governance identifiers, with the CIP-105 legacy form alongside. */
  governance: Record<'drep' | 'ccCold' | 'ccHot', { cip129: string; cip105: string }>;
}

/**
 * One observation of a real node's behavior. This is evidence, not an
 * expectation: it records what happened, with a transaction hash anyone can
 * look up.
 *
 * When `accepted` contradicts the matching satisfaction case's `expected`, the
 * node is right and the reference evaluator has a defect. Resolving that by
 * editing the observation is the one thing that destroys the value of the whole
 * corpus. See spec/05-conformance.md.
 */
export interface ChainObservation {
  network: Exclude<Network, 'mainnet'>;
  role: CredentialRole;
  /** What was attempted: 'spend', 'register', 'delegate', 'withdraw', 'vote', 'retire'. */
  action: string;
  /** The satisfaction case this exercise was built to reproduce, when there is one. */
  caseId?: string;
  accepted: boolean;
  /** Transaction hash when submission succeeded, so the claim is checkable. */
  txHash?: string;
  /** The node's or the submit API's verbatim error when it did not. */
  error?: string;
  /** ISO 8601, so a stale observation against a since-changed protocol is visible. */
  observedAt: string;
}

export interface Vector {
  formatVersion: number;
  id: string;
  family: string;
  /** The question this vector exists to answer, copied from its family. */
  question: string;
  params: Record<string, unknown>;

  /** Canonical JSON form. Key order is fixed so files compare byte for byte. */
  script: unknown;
  shape: ScriptShape;
  /** Structural oddities. Present here means intentional, not a defect. */
  remarks: ScriptRemark[];

  encoding: {
    /** CBOR of the script alone. */
    cborHex: string;
    /** The exact bytes hashed: language tag 0x00 followed by the CBOR. */
    preimageHex: string;
    /** blake2b-224 of the preimage. */
    scriptHash: string;
    /** Byte length of the CBOR, the number that governs how much fits in a transaction. */
    cborBytes: number;
  };

  credentials: VectorCredentials;
  satisfaction: SatisfactionCase[];
  /** Empty until a chain exercise runs. Never fabricated. */
  onchain: ChainObservation[];
}

export interface CorpusIndex {
  formatVersion: number;
  generatedAt: string;
  /** Arachne version that generated the corpus. */
  generator: string;
  families: { name: string; question: string; count: number }[];
  vectorCount: number;
  satisfactionCaseCount: number;
  observationCount: number;
  /** Digest over every vector's id and script hash, so drift is one comparison. */
  digest: string;
  vectors: { id: string; family: string; path: string; scriptHash: string }[];
}
