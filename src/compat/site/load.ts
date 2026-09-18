import { readFile } from 'node:fs/promises';
import { DEFAULT_AGGREGATE_PATH, type CompatAggregate } from '../aggregate.js';
import { DEFAULT_VERSION_PATH, type CompatVersionDocument } from '../version.js';
import { DEFAULT_RESULTS_DIR, loadResultsForTool } from '../results.js';
import type { CompatResult } from '../result-schema.js';
import { DEFAULT_OBSERVED_SCRIPTS_PATH, type ObservedScriptsFile } from '../../chain/observed.js';
import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from '../../chain/evidence.js';
import { DEFAULT_CORPUS_DIR, loadAllVectors, loadIndex } from '../../vectors/load.js';
import type { SiteData, VectorSummary } from './data.js';

export interface SiteDataPaths {
  aggregate?: string;
  version?: string;
  resultsDir?: string;
  observedScripts?: string;
  chainEvidence?: string;
  corpusDir?: string;
}

/**
 * Reads every committed file the site is rendered from. The aggregate is
 * read as committed rather than rebuilt here, the same as the deploy
 * workflow, which checks it is current before building anything.
 */
export async function loadSiteData(paths: SiteDataPaths = {}): Promise<SiteData> {
  const [aggregateRaw, versionRaw, observedRaw, chainEvidence, index, vectorFiles] =
    await Promise.all([
      readFile(paths.aggregate ?? DEFAULT_AGGREGATE_PATH, 'utf8'),
      readFile(paths.version ?? DEFAULT_VERSION_PATH, 'utf8'),
      readFile(paths.observedScripts ?? DEFAULT_OBSERVED_SCRIPTS_PATH, 'utf8'),
      loadChainEvidence(paths.chainEvidence ?? DEFAULT_CHAIN_EVIDENCE_PATH),
      loadIndex(paths.corpusDir ?? DEFAULT_CORPUS_DIR),
      loadAllVectors(paths.corpusDir ?? DEFAULT_CORPUS_DIR),
    ]);
  const aggregate = JSON.parse(aggregateRaw) as CompatAggregate;
  const version = JSON.parse(versionRaw) as CompatVersionDocument;
  const observed = JSON.parse(observedRaw) as ObservedScriptsFile;

  const results = new Map<string, readonly CompatResult[]>();
  for (const tool of aggregate.tools) {
    results.set(
      tool.id,
      await loadResultsForTool(tool.id, paths.resultsDir ?? DEFAULT_RESULTS_DIR),
    );
  }

  const vectors = new Map<string, VectorSummary>();
  for (const vector of vectorFiles) {
    vectors.set(vector.id, {
      id: vector.id,
      family: vector.family,
      question: vector.question,
      params: vector.params,
      shape: vector.shape,
      encodingSensitive: vector.encoding.encodingSensitive,
    });
  }

  return {
    aggregate,
    version,
    results,
    observed,
    chainEvidence,
    vectors,
    corpus: { vectorCount: index.vectorCount, digest: index.digest },
  };
}
