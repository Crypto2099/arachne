import type { CompatAggregate } from '../aggregate.js';
import type { CompatVersionDocument } from '../version.js';
import type { CompatResult } from '../result-schema.js';
import type { ObservedScriptsFile } from '../../chain/observed.js';
import type { ChainEvidenceRecord } from '../../chain/evidence.js';
import type { ScriptShape } from '../../model/invariants.js';

/**
 * What one corpus vector is, in enough detail to describe it on a result
 * page: which family and question it belongs to, the parameters that
 * produced it, and its shape. Everything else a vector file carries (both
 * encodings, credentials, satisfaction cases) is on GitHub one link away.
 */
export interface VectorSummary {
  id: string;
  family: string;
  question: string;
  params: Record<string, unknown>;
  shape: ScriptShape;
  /** True when the two framings produce different bytes for this script. */
  encodingSensitive: boolean;
}

/**
 * Everything the site is rendered from. All of it is committed data read
 * from disk at build time; nothing here is fetched, and nothing is computed
 * by the site that a result file does not already carry.
 */
export interface SiteData {
  aggregate: CompatAggregate;
  version: CompatVersionDocument;
  /** Every committed result file, keyed by tool id, highest version first. */
  results: ReadonlyMap<string, readonly CompatResult[]>;
  /** The scripts a node has carried, which the chain-script question is measured against. */
  observed: ObservedScriptsFile;
  chainEvidence: ChainEvidenceRecord;
  /** Corpus vectors by id, for describing a vector a result names. */
  vectors: ReadonlyMap<string, VectorSummary>;
  /** `vectors/index.json`'s own vector count and digest, for naming the set a run used. */
  corpus: { vectorCount: number; digest: string };
}
