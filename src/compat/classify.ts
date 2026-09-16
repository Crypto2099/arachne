import type { Vector } from '../vectors/schema.js';
import type { HashOutcome } from './types.js';

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
}

/**
 * Neither of a script's two valid hashes is canonical (spec/07), so a tool's
 * hash "agrees" whenever it matches either one recorded on the vector. It
 * only "diverges" when it matches neither, which is a hash the corpus has
 * never seen justified by either encoder.
 */
export function classifyOutcome(vector: Vector, outcome: HashOutcome): VectorResult {
  if (outcome.status === 'refused' || outcome.status === 'unsupported') {
    return { id: vector.id, status: outcome.status, error: outcome.error };
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
  };
}

export type Framing = 'definite' | 'cardanoBinary' | 'mixed' | 'undetermined';

/**
 * Which framing a tool follows, read off the vectors where the two encodings
 * actually differ (`encoding-boundary`, and any `breadth` case past 23
 * children). A vector where both encodings coincide agrees with the tool
 * regardless of which rule it follows and says nothing about which one that
 * is, so those are not evidence here.
 */
export function deriveFraming(results: VectorResult[]): Framing {
  const decisive = results.filter(
    (r) => r.matchedFraming === 'definite' || r.matchedFraming === 'cardanoBinary',
  );
  if (decisive.length === 0) return 'undetermined';
  const framings = new Set(decisive.map((r) => r.matchedFraming));
  if (framings.size > 1) return 'mixed';
  const [only] = framings;
  return only as Framing;
}
