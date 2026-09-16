import type { Channel, ConstructionPath, EngineRelation } from './types.js';
import type { Framing, VectorResult } from './classify.js';

/** Bumped whenever the result file shape changes in a way a renderer must notice. */
export const RESULT_FORMAT_VERSION = 2;

export interface CompatSummary {
  total: number;
  agreed: number;
  diverged: number;
  refused: number;
  unsupported: number;
}

/**
 * One tool version's run against the committed corpus. `compat/README.md`
 * documents this shape for a reader who never opens the code.
 *
 * `status: 'untested'` is itself the finding when a version could not be
 * installed at all: `reason` carries the tool's or npm's verbatim error, and
 * `vectors` is empty rather than filled with a guess. This is the same rule
 * as a chain observation: absence of a result is recorded as absence, never
 * as a plausible-looking pass.
 */
/**
 * The encoder that actually produced this run's bytes, and the version of it
 * that was on disk at the time.
 *
 * `resolvedVersion` is read from the install rather than from the registry,
 * because a declared range moves. It is what lets a reader see that a library
 * shipped an engine several releases behind upstream, which is the difference
 * between "fixed" and "fixed and delivered".
 */
export interface ResultEngine {
  id: string;
  relation: EngineRelation;
  resolvedVersion: string | null;
  /** Why `resolvedVersion` is null, when it is. */
  note?: string;
}

export interface CompatResult {
  formatVersion: number;
  tool: string;
  version: string;
  channel: Channel;
  /** Which construction path this run exercised. */
  path: ConstructionPath;
  engine: ResultEngine;
  testedAt: string;
  corpusDigest: string;
  arachneVersion: string;
  status: 'tested' | 'untested';
  reason?: string;
  framing: Framing | null;
  vectors: VectorResult[];
  summary: CompatSummary;
}

export function summarize(vectors: VectorResult[]): CompatSummary {
  const summary: CompatSummary = {
    total: vectors.length,
    agreed: 0,
    diverged: 0,
    refused: 0,
    unsupported: 0,
  };
  for (const v of vectors) summary[v.status] += 1;
  return summary;
}
