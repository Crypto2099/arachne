import { readFile } from 'node:fs/promises';
import type { Vector } from '../vectors/schema.js';

/**
 * The chain evidence record: every real submission cited anywhere in this
 * project's specification, in one machine-readable file.
 *
 * This is authored, not generated. A vector's own `onchain` array is
 * produced by a chain exercise and carried forward by `writeCorpus`, but
 * most of what is recorded here predates the exercise automation and exists
 * only because it was transcribed by hand from spec/06-chain-exercises.md
 * and its neighbors, each value checked against what that document states.
 * Nothing here is computed, and nothing under `vectors:build` or any other
 * regeneration step may touch this file: nothing in this module writes it.
 * See chain-evidence/README.md.
 */
export const CHAIN_EVIDENCE_FORMAT_VERSION = 1;

export const DEFAULT_CHAIN_EVIDENCE_PATH = 'chain-evidence/observations.json';

export type ChainEvidenceNetwork = 'mainnet' | 'preprod' | 'preview';

/**
 * Facts about the script or the transaction that carried it, stated only
 * where the source names them. An entry with a `vectorId` gets these facts
 * from the vector instead; this is for the entries that have no vector,
 * because the script exercised a protocol limit rather than a corpus shape.
 */
export interface ChainEvidenceShape {
  /** Nesting depth, leaf at depth 1, matching `ScriptShape.depth`. */
  depth?: number;
  /** Signing keys named in the script, whether or not each one is required. */
  keyCount?: number;
  /** CBOR length of the script alone. */
  scriptBytes?: number;
  /** CBOR length of the transaction that carried this observation. */
  transactionBytes?: number;
}

export interface ChainEvidenceEntry {
  network: ChainEvidenceNetwork;
  /** Present when accepted. A rejected submission recorded no hash. */
  txHash?: string;
  accepted: boolean;
  /** ISO 8601. Absent where the source does not state one. */
  observedAt?: string;
  /** What this submission shows, in the source's own terms. */
  demonstrates: string;
  /** The ledger's or the submit API's verbatim error. Required when `accepted` is false. */
  error?: string;
  /**
   * The submitted transaction's raw CBOR, lowercase hex, named to match
   * `EncodingRecord.cborHex` and `ChainObservation.cborHex`. Left absent
   * here throughout: the transcription that populated this record has only
   * the spec's prose to work from, which never quotes transaction bytes, so
   * inventing a value would be exactly the fabricated observation this
   * project's invariants forbid.
   */
  cborHex?: string;
  /** The corpus vector this observation is about, when the script is a generated one. */
  vectorId?: string;
  shape?: ChainEvidenceShape;
  /** Where this entry was transcribed from: a spec document and section. */
  source: string;
}

export interface ChainEvidenceRecord {
  formatVersion: number;
  entryCount: number;
  entries: ChainEvidenceEntry[];
}

export async function loadChainEvidence(
  path: string = DEFAULT_CHAIN_EVIDENCE_PATH,
): Promise<ChainEvidenceRecord> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as ChainEvidenceRecord;
}

const TX_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Checks a single entry against the shape rules stated in the task this
 * record answers: an acceptance carries a hash, a rejection carries an
 * error, and every hash present is 64 lowercase hex characters, which is
 * what a blake2b-256 transaction id always is.
 */
export function validateChainEvidenceEntry(entry: ChainEvidenceEntry): string[] {
  const problems: string[] = [];

  if (entry.accepted && !entry.txHash) {
    problems.push('accepted is true but txHash is absent');
  }
  if (!entry.accepted && !entry.error) {
    problems.push('accepted is false but error is absent');
  }
  if (entry.txHash !== undefined && !TX_HASH_PATTERN.test(entry.txHash)) {
    problems.push(`txHash is not 64 lowercase hex characters: ${entry.txHash}`);
  }
  if (!entry.demonstrates) {
    problems.push('demonstrates is empty');
  }
  if (!entry.source) {
    problems.push('source is empty');
  }

  return problems;
}

export function validateChainEvidenceRecord(record: ChainEvidenceRecord): string[] {
  const problems: string[] = [];
  if (record.formatVersion !== CHAIN_EVIDENCE_FORMAT_VERSION) {
    problems.push(
      `formatVersion is ${record.formatVersion}, expected ${CHAIN_EVIDENCE_FORMAT_VERSION}`,
    );
  }
  if (record.entryCount !== record.entries.length) {
    problems.push(`entryCount is ${record.entryCount}, but entries has ${record.entries.length}`);
  }
  for (const entry of record.entries) {
    for (const problem of validateChainEvidenceEntry(entry)) {
      problems.push(`${entry.txHash ?? '(no txHash)'}: ${problem}`);
    }
  }
  return problems;
}

/**
 * Cross-checks one entry against the vector it names, when it names one.
 *
 * The record does not own this data: a vector's own `onchain` array is what
 * the verifier's contradiction check reads, and this entry is only a
 * pointer into it. Agreement is checked on the fields that matter for that
 * pointer to be trustworthy, network, txHash and accepted, rather than on
 * every field, so the two are free to carry different prose without that
 * counting as drift.
 */
export function checkAgainstVector(entry: ChainEvidenceEntry, vectors: Vector[]): string[] {
  if (!entry.vectorId) return [];
  const problems: string[] = [];
  const vector = vectors.find((v) => v.id === entry.vectorId);
  if (!vector) {
    problems.push(`vectorId ${entry.vectorId} does not match any vector on disk`);
    return problems;
  }

  const onchain = vector.onchain ?? [];
  const match = onchain.find(
    (o) =>
      o.network === entry.network && o.accepted === entry.accepted && o.txHash === entry.txHash,
  );
  if (!match) {
    problems.push(
      `${entry.vectorId}: no onchain observation on ${entry.network} agrees on accepted=${entry.accepted} txHash=${entry.txHash ?? '(none)'}`,
    );
  }
  return problems;
}

/**
 * Checks the direction `checkAgainstVector` does not: that every observation
 * a vector actually carries in its own `onchain` array has a matching entry
 * in the record.
 *
 * `checkAgainstVector` only ever looks at entries the record already has, so
 * a vector observation the record simply never transcribed is invisible to
 * it: a record missing every rejection would still cross-check clean, since
 * there was nothing to disagree with. This walks from the vectors instead,
 * so an observation that exists on disk and has no counterpart here is the
 * finding, not something a per-entry check could ever produce.
 */
export function checkVectorCoverage(vectors: Vector[], record: ChainEvidenceRecord): string[] {
  const problems: string[] = [];
  for (const vector of vectors) {
    for (const observation of vector.onchain ?? []) {
      const match = record.entries.find(
        (e) =>
          e.vectorId === vector.id &&
          e.network === observation.network &&
          e.accepted === observation.accepted &&
          e.txHash === observation.txHash,
      );
      if (!match) {
        problems.push(
          `${vector.id}: onchain observation on ${observation.network} (accepted=${observation.accepted}, txHash=${observation.txHash ?? '(none)'}) has no matching record entry`,
        );
      }
    }
  }
  return problems;
}
