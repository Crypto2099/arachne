import type { Vector } from '../vectors/schema.js';
import type { ObservedCase } from './corpus.js';
import type { ConstructionPath, DecodeOutcome, HashOutcome } from './types.js';

export type VectorStatus = 'agreed' | 'diverged' | 'refused' | 'unsupported';

/** Which of the corpus's two recorded hashes, if either, a tool's answer matched. */
export type MatchedFraming = 'definite' | 'cardanoBinary' | 'both' | 'neither';

export interface VectorResult {
  id: string;
  status: VectorStatus;
  /** Present when the tool produced a hash, whatever it was. */
  hash?: string;
  matchedFraming?: MatchedFraming;
  /** The tool's verbatim text, present on `refused` and `unsupported`. */
  error?: string;
  /**
   * Which of the vector's two CBOR encodings this answer is about. Present
   * only on the decode path: a vector is one question on `construct` but two
   * on `decode` (feed the definite bytes, then feed the cardanoBinary bytes),
   * and this is what tells the two apart in the flat `vectors` array a result
   * file carries.
   */
  inputFraming?: 'definite' | 'cardanoBinary';
}

/**
 * Neither of a script's two valid hashes is canonical (spec/07), so a tool's
 * hash "agrees" whenever it matches either one recorded on the vector. It
 * only "diverges" when it matches neither, which is a hash the corpus has
 * never seen justified by either encoder.
 */
export function classifyOutcome(
  vector: Vector,
  outcome: HashOutcome,
  inputFraming?: 'definite' | 'cardanoBinary',
): VectorResult {
  if (outcome.status === 'refused' || outcome.status === 'unsupported') {
    return {
      id: vector.id,
      status: outcome.status,
      error: outcome.error,
      ...(inputFraming === undefined ? {} : { inputFraming }),
    };
  }

  const hash = outcome.hash.toLowerCase();
  const matchesDefinite = hash === vector.encoding.definite.scriptHash.toLowerCase();
  const matchesCardanoBinary = hash === vector.encoding.cardanoBinary.scriptHash.toLowerCase();

  const matchedFraming: MatchedFraming =
    matchesDefinite && matchesCardanoBinary
      ? 'both'
      : matchesDefinite
        ? 'definite'
        : matchesCardanoBinary
          ? 'cardanoBinary'
          : 'neither';

  return {
    id: vector.id,
    status: matchedFraming === 'neither' ? 'diverged' : 'agreed',
    hash: outcome.hash,
    matchedFraming,
    ...(inputFraming === undefined ? {} : { inputFraming }),
  };
}

/**
 * The decode path's two questions for one vector, feeding it the definite
 * bytes and then the cardanoBinary bytes, each becoming its own
 * `VectorResult` tagged with which encoding it answers for. Kept apart from
 * `classifyOutcome` so the pairing is stated once rather than at every call
 * site that runs the decode path.
 */
export function classifyDecodeOutcome(vector: Vector, outcome: DecodeOutcome): VectorResult[] {
  return [
    classifyOutcome(vector, outcome.definite, 'definite'),
    classifyOutcome(vector, outcome.cardanoBinary, 'cardanoBinary'),
  ];
}

/**
 * One observed script's result: did the tool return the hash those exact bytes
 * have?
 *
 * Stricter than `classifyOutcome`, and deliberately so. A corpus vector has two
 * valid hashes and matching either counts as agreement, because neither framing
 * is canonical and the vector exists in both. These bytes exist in one form, on
 * a chain, and have one hash. A tool that returns the other framing's hash has
 * decoded and re-encoded a script that is live, and would hand back an address
 * that holds no funds.
 *
 * `matchedFraming` still names which framing the answer corresponds to, so a
 * divergence says what the tool did rather than only that it was wrong. When
 * this library cannot decode the bytes there is nothing to re-encode, so the
 * comparison hashes are absent and the answer is either right or unexplained.
 */
export function classifyObservedOutcome(
  observed: ObservedCase,
  outcome: HashOutcome,
): VectorResult {
  if (outcome.status === 'refused' || outcome.status === 'unsupported') {
    return { id: observed.id, status: outcome.status, error: outcome.error };
  }

  const hash = outcome.hash.toLowerCase();
  const matchesDefinite = observed.definiteHash !== undefined && hash === observed.definiteHash;
  const matchesCardanoBinary =
    observed.cardanoBinaryHash !== undefined && hash === observed.cardanoBinaryHash;

  const matchedFraming: MatchedFraming =
    matchesDefinite && matchesCardanoBinary
      ? 'both'
      : matchesDefinite
        ? 'definite'
        : matchesCardanoBinary
          ? 'cardanoBinary'
          : 'neither';

  // `inputFraming` means the same thing here as on the vector decode path:
  // which framing the bytes handed over are in. It is knowable only when one
  // encoder reproduces them; where both do, the bytes are the same either way
  // and the answer says nothing about which rule the tool follows.
  const inputFraming = observed.framings.length === 1 ? observed.framings[0] : undefined;

  return {
    id: observed.id,
    status: hash === observed.observedHash ? 'agreed' : 'diverged',
    hash: outcome.hash,
    matchedFraming,
    ...(inputFraming === undefined ? {} : { inputFraming }),
  };
}

export type Framing =
  'definite' | 'cardanoBinary' | 'mixed' | 'framing-preserving' | 'undetermined';

/**
 * Which framing a tool follows, read off the vectors where the two encodings
 * actually differ (`encoding-boundary`, and any `breadth` case past 23
 * children). A vector where both encodings coincide agrees with the tool
 * regardless of which rule it follows and says nothing about which one that
 * is, so those are not evidence here.
 *
 * `framing-preserving` is reachable on the two paths that feed bytes in,
 * `decode` and `decode-onchain`: it means that, across every decisive case,
 * the hash returned matches whichever encoding was actually fed in, rather
 * than the tool normalizing every input toward one framing regardless of what
 * it was handed. That distinction does not exist on `construct`, where there
 * is only one input per vector and nothing was handed over to preserve, so
 * the path has to be given rather than inferred from the results alone.
 */
export function deriveFraming(results: VectorResult[], path: ConstructionPath): Framing {
  const decisive = results.filter(
    (r) => r.matchedFraming === 'definite' || r.matchedFraming === 'cardanoBinary',
  );
  if (decisive.length === 0) return 'undetermined';

  if (path !== 'construct' && decisive.every((r) => r.matchedFraming === r.inputFraming)) {
    return 'framing-preserving';
  }

  const framings = new Set(decisive.map((r) => r.matchedFraming));
  if (framings.size > 1) return 'mixed';
  const [only] = framings;
  return only as Framing;
}
