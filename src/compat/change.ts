import type { CompatResult } from './result-schema.js';

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

  const previousById = new Map(previous.vectors.map((v) => [v.id, v.status]));
  const transitions = new Map<string, number>();
  let vectorsChanged = 0;
  for (const vector of current.vectors) {
    const before = previousById.get(vector.id);
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
