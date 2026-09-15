import { DEFAULT_CORPUS_DIR, loadAllVectors, loadIndex } from '../vectors/load.js';
import type { Vector } from '../vectors/schema.js';

export interface CompatCorpus {
  vectors: Vector[];
  /** `vectors/index.json`'s own digest, recorded verbatim rather than recomputed. */
  digest: string;
  generator: string;
}

/**
 * The committed corpus, as the compat runner sees it: every vector on disk,
 * plus the digest already recorded in `vectors/index.json`. The digest is
 * read rather than recomputed so a result file always states the digest of
 * the corpus actually on disk when the tool ran, whatever produced it.
 */
export async function loadCompatCorpus(dir = DEFAULT_CORPUS_DIR): Promise<CompatCorpus> {
  const [vectors, index] = await Promise.all([loadAllVectors(dir), loadIndex(dir)]);
  if (vectors.length === 0) {
    throw new Error(`no vectors found under ${dir}. Run "npm run vectors:build" first.`);
  }
  return { vectors, digest: index.digest, generator: index.generator };
}
