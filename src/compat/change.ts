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
  /** False for the first version ever recorded for a tool: there was nothing to compare against, which is not the same claim as "unchanged". */
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
  let changed = false;

  if (current.framing !== previous.framing) {
    changed = true;
    details.push(
      `framing changed from ${previous.framing ?? 'undetermined'} to ${current.framing ?? 'undetermined'}`,
    );
  }

  const previousById = new Map(previous.vectors.map((v) => [vectorKey(v), v.status]));
  const transitions = new Map<string, number>();
  let vectorsChanged = 0;
  for (const vector of current.vectors) {
    const before = previousById.get(vectorKey(vector));
    if (before === undefined || before === vector.status) continue;
    vectorsChanged += 1;
    const key = `${before} -> ${vector.status}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  if (vectorsChanged > 0) {
    changed = true;
    details.push(
      `${vectorsChanged} vector${vectorsChanged === 1 ? '' : 's'} changed status versus ${previousLabel}: ` +
        [...transitions.entries()].map(([k, n]) => `${n} ${k}`).join(', '),
    );
  }

  const headline = changed
    ? `${label}: behavior differs from ${previousLabel}`
    : `${label}: behaves the same as ${previousLabel}`;

  return { changed, hadBaseline: true, headline, details };
}
