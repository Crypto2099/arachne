import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_AGGREGATE_PATH } from './aggregate.js';
import type { CompatAggregate } from './aggregate.js';

/**
 * Bumped whenever this document's own shape changes in a way a consumer must
 * notice. Independent of `AGGREGATE_FORMAT_VERSION`: this is a small,
 * separate document a consumer polls to decide whether to refetch the
 * aggregate, not a summary of it.
 */
export const VERSION_FORMAT_VERSION = 1;

export const DEFAULT_VERSION_PATH = 'compat/version.json';

/**
 * A small, stable document a consumer fetches (or conditionally re-fetches)
 * to decide whether `compat/aggregate.json` has moved, without downloading
 * and diffing the whole thing. Every field is derived from committed data;
 * none is a wall-clock reading, which is what keeps this file byte-stable
 * across a rebuild that changed nothing (compat/README.md, "Freshness").
 */
export interface CompatVersionDocument {
  formatVersion: number;
  /** Carried from the aggregate unchanged: the latest `testedAt` among every result it holds. */
  latestTestedAt: string | null;
  /**
   * Lowercase hex of the sha256 digest of `compat/aggregate.json`'s exact
   * committed bytes. `latestTestedAt` alone is not a complete change signal:
   * it moves when a result is added, but not when one is removed, and not
   * when `compat/tools.json` changes an engine relation without any new
   * test run. Hashing the file itself catches both.
   */
  aggregateDigest: string;
  /** `aggregate.json`'s own tool and result counts, so a consumer can sanity-check a fetch without parsing it. */
  toolCount: number;
  resultCount: number;
}

/**
 * Build the version document from `compat/aggregate.json` as it sits on
 * disk. Reads the file rather than rebuilding the aggregate in memory: the
 * digest has to be over the bytes a consumer will actually fetch, and
 * `npm run compat:aggregate:check` is what already guarantees those bytes
 * match what `compat/tools.json` and `compat/results/` produce.
 */
export async function buildVersionDocument(
  aggregatePath = DEFAULT_AGGREGATE_PATH,
): Promise<CompatVersionDocument> {
  const bytes = await readFile(aggregatePath);
  const aggregate = JSON.parse(bytes.toString('utf8')) as CompatAggregate;
  const resultCount = aggregate.tools.reduce((n, t) => n + t.results.length, 0);

  return {
    formatVersion: VERSION_FORMAT_VERSION,
    latestTestedAt: aggregate.latestTestedAt,
    aggregateDigest: createHash('sha256').update(bytes).digest('hex'),
    toolCount: aggregate.tools.length,
    resultCount,
  };
}

/** The exact bytes this project commits to `compat/version.json`. */
export function serializeVersionDocument(doc: CompatVersionDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
