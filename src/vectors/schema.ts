import type { ScriptRemark, ScriptShape } from '../model/invariants.js';
import type { Network } from '../encode/credential.js';

/** Bumped whenever the vector file shape changes in a way a consumer must notice. */
export const VECTOR_FORMAT_VERSION = 3;

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
/**
 * The protocol parameters in effect when an observation was made.
 *
 * Every size result this project records is a consequence of `maxTxSize`, which
 * governance can raise or lower. An observation that a 123-member multisig was
 * refused for size says nothing useful without the limit it was refused
 * against: read later under a different parameter set it looks like a structural
 * finding when it was an arithmetic one. A timestamp does not fix this, because
 * a reader cannot recover a past parameter set from a date.
 *
 * So the parameters travel with the observation. A result whose parameters
 * differ from today's is still true, and is now legibly true of a different
 * chain configuration.
 */
export interface ObservedProtocolParams {
  /** Epoch the submission landed in, so the value can be checked against history. */
  epoch: number;
  maxTxSize: number;
  minFeeA: number;
  minFeeB: number;
  /** Absent on a node predating reference script fee tiering. */
  minFeeRefScriptCostPerByte?: number;
}

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
  /**
   * The submitted transaction's raw CBOR, lowercase hex, named to match
   * `EncodingRecord.cborHex`.
   *
   * Worth capturing on a rejection as much as on an acceptance, and for an
   * asymmetric reason: an accepted transaction's bytes stay retrievable from
   * the chain itself by `txHash` for as long as the chain exists, but a
   * rejected transaction never reaches a chain, so its bytes exist nowhere
   * afterwards and cannot be reconstructed later, since its fee, inputs and
   * TTL vary with every build. Absent on an observation recorded before this
   * field existed.
   */
  cborHex?: string;
  /** ISO 8601. Says when, not under what: `protocolParams` carries that. */
  observedAt: string;
  /** The parameter set this result is true of. */
  protocolParams: ObservedProtocolParams;
}

/** One encoding's bytes and the hash taken over them. */
export interface EncodingRecord {
  /** CBOR of the script alone. */
  cborHex: string;
  /** The exact bytes hashed: language tag 0x00 followed by the CBOR. */
  preimageHex: string;
  /** blake2b-224 of the preimage. */
  scriptHash: string;
  /** Byte length of the CBOR, the number that governs how much fits in a transaction. */
  cborBytes: number;
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

  /**
   * Both encodings, because the same logical script has two valid hashes.
   *
   * `definite` frames every sub-script list as a definite-length array, which is
   * what cardano-serialization-lib and most JavaScript tooling produce.
   * `cardanoBinary` reproduces `wrapCBORArray`, definite up to 23 children and
   * indefinite from 24 up, which is what cardano-cli and cardano-node produce.
   *
   * They are byte-identical unless some container holds 24 or more sub-scripts.
   * When they differ, `encodingSensitive` is true and the script has two valid
   * addresses and two valid governance identifiers. See
   * spec/07-encoding-divergence.md.
   */
  encoding: {
    definite: EncodingRecord;
    cardanoBinary: EncodingRecord;
    encodingSensitive: boolean;
  };

  /** One credential set per encoding, since each hash yields its own addresses. */
  credentials: {
    definite: VectorCredentials;
    cardanoBinary: VectorCredentials;
  };
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
  /** How many vectors have two different valid hashes. */
  encodingSensitiveCount: number;
  /** Digest over every vector's id and both script hashes, so drift is one comparison. */
  digest: string;
  vectors: {
    id: string;
    family: string;
    path: string;
    scriptHash: string;
    cardanoBinaryScriptHash: string;
  }[];
}
