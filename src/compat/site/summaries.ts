import type { AggregateTool } from '../aggregate.js';
import type { CompatResult } from '../result-schema.js';
import type { MatchedFraming, VectorResult, VectorStatus } from '../classify.js';
import type { Channel, ConstructionPath } from '../types.js';
import { CONSTRUCTION_PATHS } from '../types.js';
import { sortVersionsDescending } from '../semver.js';
import { OUTCOME_ORDER } from './vocabulary.js';

/**
 * Where a page for one result file lives, relative to the site root. The
 * name mirrors the committed JSON file's own name (`<version>.json` for the
 * building question, `<version>-<path>.json` for the others), so the page
 * and the file it renders are found by the same name.
 */
export function resultFileStem(result: Pick<CompatResult, 'version' | 'path'>): string {
  const suffix = result.path === 'construct' ? '' : `-${result.path}`;
  return `${result.version}${suffix}`;
}

export function resultPagePath(result: Pick<CompatResult, 'tool' | 'version' | 'path'>): string {
  return `results/${result.tool}/${resultFileStem(result)}.html`;
}

export function toolPagePath(toolId: string): string {
  return `tools/${toolId}.html`;
}

/**
 * The result that answers for a tool today on one question: the latest
 * release's, when it has one, otherwise the highest version tested on that
 * question. A pre-release is never the answer on its own, because a reader
 * installing the tool gets the latest release, not the beta.
 */
export function latestResult(
  results: readonly CompatResult[],
  path: ConstructionPath,
): CompatResult | undefined {
  const onPath = results.filter((r) => r.path === path);
  const current = onPath.find((r) => r.channel === 'current');
  if (current) return current;
  const stable = onPath.filter((r) => r.channel !== 'beta');
  const pool = stable.length > 0 ? stable : onPath;
  if (pool.length === 0) return undefined;
  const [top] = sortVersionsDescending(pool.map((r) => r.version));
  return pool.find((r) => r.version === top);
}

/**
 * Three different states share "no row in the table", and a page has to
 * tell them apart: a question the tool is not asked at all (`unmeasured`),
 * one it is registered for but has no result on yet (`pending`), and one
 * that was answered.
 */
export type PathState =
  { kind: 'unmeasured' } | { kind: 'pending' } | { kind: 'result'; result: CompatResult };

export function pathState(
  tool: AggregateTool,
  results: readonly CompatResult[],
  path: ConstructionPath,
): PathState {
  if (!tool.paths.includes(path)) return { kind: 'unmeasured' };
  const result = latestResult(results, path);
  return result ? { kind: 'result', result } : { kind: 'pending' };
}

/** One release's answer for one script, inside a problem grouped across releases. */
export interface ProblemOccurrence {
  version: string;
  channel: Channel;
  hash?: string;
  matchedFraming?: MatchedFraming;
  error?: string;
}

/**
 * One script a tool did not get right, on one question, with every release
 * it was seen on. Grouped this way because the same refusal repeats
 * identically across a tool's releases, and a page listing it once per
 * release would bury the one that changed.
 */
export interface Problem {
  path: ConstructionPath;
  status: Exclude<VectorStatus, 'agreed'>;
  vectorId: string;
  inputFraming?: 'definite' | 'cardanoBinary';
  occurrences: ProblemOccurrence[];
}

export function problemsAcrossReleases(results: readonly CompatResult[]): Problem[] {
  const groups = new Map<string, Problem>();
  for (const result of results) {
    for (const vector of result.vectors) {
      if (vector.status === 'agreed') continue;
      const key = [result.path, vector.status, vector.id, vector.inputFraming ?? ''].join('|');
      let problem = groups.get(key);
      if (!problem) {
        problem = {
          path: result.path,
          status: vector.status,
          vectorId: vector.id,
          ...(vector.inputFraming === undefined ? {} : { inputFraming: vector.inputFraming }),
          occurrences: [],
        };
        groups.set(key, problem);
      }
      problem.occurrences.push({
        version: result.version,
        channel: result.channel,
        ...(vector.hash === undefined ? {} : { hash: vector.hash }),
        ...(vector.matchedFraming === undefined ? {} : { matchedFraming: vector.matchedFraming }),
        ...(vector.error === undefined ? {} : { error: vector.error }),
      });
    }
  }
  return [...groups.values()].sort(compareProblems);
}

function compareProblems(a: Problem, b: Problem): number {
  const status = OUTCOME_ORDER.indexOf(a.status) - OUTCOME_ORDER.indexOf(b.status);
  if (status !== 0) return status;
  const path = CONSTRUCTION_PATHS.indexOf(a.path) - CONSTRUCTION_PATHS.indexOf(b.path);
  if (path !== 0) return path;
  const id = a.vectorId.localeCompare(b.vectorId);
  if (id !== 0) return id;
  return (a.inputFraming ?? '').localeCompare(b.inputFraming ?? '');
}

/**
 * Problems that say the same thing about different scripts, together: the
 * same verbatim error on one question, or wrong hashes with the same
 * explanation. A library that times out on eighteen deep scripts has one
 * problem with eighteen instances, not eighteen problems, and a page that
 * lists it eighteen times buries the one card that differs.
 */
export interface ProblemGroup {
  path: ConstructionPath;
  status: Exclude<VectorStatus, 'agreed'>;
  /** Distinct verbatim texts for a refusal, or the framing the wrong hashes correspond to. */
  signature: string;
  problems: Problem[];
}

export function groupProblems(problems: readonly Problem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const problem of problems) {
    const signature =
      problem.status === 'diverged'
        ? (problem.occurrences[0]?.matchedFraming ?? 'neither')
        : errorVariants(problem)
            .map((v) => v.error)
            .sort()
            .join('\n');
    const key = [problem.path, problem.status, signature].join('|');
    let group = groups.get(key);
    if (!group) {
      group = { path: problem.path, status: problem.status, signature, problems: [] };
      groups.set(key, group);
    }
    group.problems.push(problem);
  }
  return [...groups.values()];
}

/** The distinct error texts among a problem's occurrences, each with the releases that produced it. */
export function errorVariants(problem: Problem): { error: string; versions: string[] }[] {
  const variants = new Map<string, string[]>();
  for (const occurrence of problem.occurrences) {
    if (occurrence.error === undefined) continue;
    const versions = variants.get(occurrence.error) ?? [];
    versions.push(occurrence.version);
    variants.set(occurrence.error, versions);
  }
  return [...variants.entries()].map(([error, versions]) => ({ error, versions }));
}

/** Vectors of one result, grouped by outcome in the order the site shows them. */
export function groupByOutcome(
  vectors: readonly VectorResult[],
): Map<VectorStatus, VectorResult[]> {
  const groups = new Map<VectorStatus, VectorResult[]>(OUTCOME_ORDER.map((s) => [s, []]));
  for (const vector of vectors) groups.get(vector.status)!.push(vector);
  return groups;
}

/**
 * How a set of wrong hashes came about, from `matchedFraming`: a hash the
 * definite-length rule produces means the tool re-encoded that way, and a
 * hash neither rule produces is unexplained by either.
 */
export function divergenceBreakdown(vectors: readonly VectorResult[]): Map<MatchedFraming, number> {
  const counts = new Map<MatchedFraming, number>();
  for (const vector of vectors) {
    if (vector.status !== 'diverged') continue;
    const key = vector.matchedFraming ?? 'neither';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
