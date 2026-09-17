import type { CompatResult } from './result-schema.js';
import type { VectorResult } from './classify.js';

/**
 * A vector's id alone is only unique on the construct path. Decode asks two
 * questions per vector, one per encoding, and both share the vector's id;
 * `inputFraming` is what tells them apart, so it has to be part of the key or
 * one of the two silently overwrites the other in the lookup below.
 */
function vectorKey(v: VectorResult): string {
  return v.inputFraming === undefined ? v.id : `${v.id}#${v.inputFraming}`;
}

export interface ChangeReport {
  /** True when this version behaves differently from the one compared against. */
  changed: boolean;
  /**
   * False when there was nothing to compare against: either this is the
   * first version ever recorded for the tool, or a previous result exists
   * but shares no vector at all with this run (the id set moved under both,
   * for instance a generator family was renamed). Both are the same claim,
   * "nothing here supports a verdict", and neither is the same claim as
   * "unchanged".
   */
  hadBaseline: boolean;
  /** One line, suitable for a PR title or a table cell. */
  headline: string;
  /** Zero or more further lines, suitable for a PR body. */
  details: string[];
}

/**
 * Compare a freshly tested version against the previous version of the same
 * tool already on disk. This is the check the whole watcher exists for: a
 * new version behaving like the last one is routine, and a new version
 * behaving differently is the headline.
 */
export function compareResults(
  current: CompatResult,
  previous: CompatResult | undefined,
): ChangeReport {
  const label = `${current.tool} ${current.version} (${current.channel})`;

  if (!previous) {
    return {
      changed: false,
      hadBaseline: false,
      headline: `${label}: first recorded result, nothing to compare against`,
      details: [],
    };
  }

  const previousLabel = `${previous.tool} ${previous.version}`;

  if (previous.status === 'untested' && current.status === 'untested') {
    return {
      changed: false,
      hadBaseline: true,
      headline: `${label}: still could not be installed, same as ${previousLabel}`,
      details: [],
    };
  }

  if (previous.status === 'untested' && current.status === 'tested') {
    return {
      changed: true,
      hadBaseline: true,
      headline: `${label}: now installs and runs; ${previousLabel} could not be installed`,
      details: [`previous failure: ${previous.reason ?? '(no reason recorded)'}`],
    };
  }

  if (previous.status === 'tested' && current.status === 'untested') {
    return {
      changed: true,
      hadBaseline: true,
      headline: `${label}: stopped installing; ${previousLabel} ran successfully`,
      details: [`failure: ${current.reason ?? '(no reason recorded)'}`],
    };
  }

  // Both tested.
  const details: string[] = [];

  // A different corpusDigest is not, by itself, a claim about the tool: it
  // can mean the corpus gained vectors since the baseline ran, or that ids
  // moved under both runs (a generator family renamed changes every id it
  // produces). Nothing here decides which; it is named so a reader can, and
  // the counts below are restricted to what the two runs actually share.
  const digestChanged = current.corpusDigest !== previous.corpusDigest;
  if (digestChanged) {
    details.push(
      `corpus digest changed from ${previous.corpusDigest} to ${current.corpusDigest}; only vectors present in both runs are compared below`,
    );
  }

  const previousById = new Map(previous.vectors.map((v) => [vectorKey(v), v.status]));
  const currentKeys = new Set(current.vectors.map((v) => vectorKey(v)));
  const transitions = new Map<string, number>();
  let vectorsChanged = 0;
  let addedVectors = 0;
  let sharedVectors = 0;
  for (const vector of current.vectors) {
    const before = previousById.get(vectorKey(vector));
    if (before === undefined) {
      // Present now, absent from the baseline entirely: there is no prior
      // status for this vector to have moved away from, so it is not a
      // transition. Folding it into `vectorsChanged` is exactly the bug
      // this function used to have, because it made every corpus growth
      // look like a behavior change in whatever version happened to run
      // right after the growth landed.
      addedVectors += 1;
      continue;
    }
    sharedVectors += 1;
    if (before === vector.status) continue;
    vectorsChanged += 1;
    const key = `${before} -> ${vector.status}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }

  // The mirror case: present in the baseline, absent from this run. Iterating
  // only `current.vectors` (as the old code did) makes this invisible, but a
  // vector a tool used to answer and no longer appears for is worth surfacing
  // even though it is not, on its own, evidence the tool's behavior changed.
  let removedVectors = 0;
  for (const vector of previous.vectors) {
    if (!currentKeys.has(vectorKey(vector))) removedVectors += 1;
  }

  if (vectorsChanged > 0) {
    details.push(
      `${vectorsChanged} vector${vectorsChanged === 1 ? '' : 's'} changed status versus ${previousLabel}: ` +
        [...transitions.entries()].map(([k, n]) => `${n} ${k}`).join(', '),
    );
  }

  // Neither of these two ever implies a behavior change: a vector the
  // baseline never saw has no regression to detect, and a vector missing
  // from this run is reported so a reader can ask why, not treated as a
  // divergence in a tool that never got the chance to answer it either way.
  if (addedVectors > 0) {
    details.push(
      `${addedVectors} vector${addedVectors === 1 ? '' : 's'} present in this run with no baseline counterpart in ${previousLabel}`,
    );
  }
  if (removedVectors > 0) {
    details.push(
      `${removedVectors} vector${removedVectors === 1 ? '' : 's'} present in ${previousLabel} missing from this run`,
    );
  }

  // Zero vectors in common leaves nothing for a verdict to rest on: `framing`
  // is an aggregate computed over each run's own full vector list, and a
  // held or moved status can only be read off a vector both runs actually
  // produced. Comparing either one here would be comparing two runs that, as
  // far as this function can tell, tested disjoint sets of scripts. That is
  // the same situation the `!previous` branch above handles (nothing to
  // compare against), reached by a different route, so it gets the same
  // answer rather than a "behaves the same" nothing here supports.
  // `hadBaseline: false` matches that reading, which keeps this result out of
  // `summaryLine`'s (scripts/compat-watch.ts) "behaves the same" bucket too.
  if (sharedVectors === 0) {
    return {
      changed: false,
      hadBaseline: false,
      headline: `${label}: shares no vector with ${previousLabel}'s recorded run, nothing to compare against`,
      details,
    };
  }

  let changed = vectorsChanged > 0;
  if (current.framing !== previous.framing) {
    changed = true;
    details.push(
      `framing changed from ${previous.framing ?? 'undetermined'} to ${current.framing ?? 'undetermined'}`,
    );
  }

  const headline = changed
    ? `${label}: behavior differs from ${previousLabel}`
    : digestChanged
      ? `${label}: behaves the same as ${previousLabel} on the vectors both runs share (corpus digest changed)`
      : `${label}: behaves the same as ${previousLabel}`;

  return { changed, hadBaseline: true, headline, details };
}
