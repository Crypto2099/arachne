import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { loadToolRegistry, isIndependentEvidence, DEFAULT_REGISTRY_PATH } from './registry.js';
import { loadResultsForTool, resultPath, DEFAULT_RESULTS_DIR } from './results.js';
import type { CompatResult, CompatSummary } from './result-schema.js';
import type { Framing } from './classify.js';
import type { Channel, ConstructionPath, EngineDefinition, EngineLink } from './types.js';

/**
 * Bumped whenever the aggregate's own shape changes in a way a renderer must
 * notice. Independent of `RESULT_FORMAT_VERSION`: the aggregate is a
 * different document with its own consumers, not a bundle of result files
 * whose format happens to travel together.
 */
export const AGGREGATE_FORMAT_VERSION = 1;

export const DEFAULT_AGGREGATE_PATH = 'compat/aggregate.json';

/**
 * One committed result, carrying what a matrix or index page needs and
 * nothing a page would have to fetch the underlying file for anyway.
 * Deliberately not the per-vector detail: that stays in `resultFile`, which
 * names exactly the file this summary was read from, so a reader who needs
 * vector-level detail knows where to go without reconstructing
 * `resultPath`'s naming rule themselves.
 */
export interface AggregateResultSummary {
  version: string;
  channel: Channel;
  path: ConstructionPath;
  testedAt: string;
  /**
   * The digest of the set this result was produced against, at the time it
   * was produced: `vectors/index.json`'s on `construct` and `decode`, and
   * `chain-evidence/scripts.json`'s on `decode-onchain`, which runs against
   * observed bytes rather than generated ones. Two results are only directly
   * comparable when this matches (compat/README.md, "corpusDigest"); carrying
   * it here is what lets a consumer tell that apart without opening the
   * underlying result file.
   */
  corpusDigest: string;
  arachneVersion: string;
  status: 'tested' | 'untested';
  reason?: string;
  /**
   * Passed through exactly as recorded, including `"mixed"` and
   * `"undetermined"`. Neither is flattened or averaged into a neighboring
   * value: compat/README.md says a mixed or undetermined reading on a version
   * that used to resolve cleanly is worth surfacing on its own.
   */
  framing: Framing | null;
  summary: CompatSummary;
  /** Where this result's full per-vector detail lives, repo-root relative. */
  resultFile: string;
}

/** One tool, its declared engine link, and every committed result for it. */
export interface AggregateTool {
  id: string;
  displayName: string;
  /** Carried from `compat/tools.json` unchanged; see `ToolDefinition`. */
  language?: string;
  usedFrom?: string;
  homepage: string;
  engine: EngineLink;
  /**
   * Which construction paths this tool is registered against in
   * `compat/tools.json`, carried through unchanged (`tools.json`'s own
   * default of `['construct']` applies here too, mirroring
   * `resolvePendingWork` in `src/compat/pending.ts`). A renderer needs this
   * to tell "not registered against `decode` at all" apart from
   * "registered, but no result has landed yet": both currently show as zero
   * `decode` results in `results[]`, and only this field says which one it
   * is.
   */
  paths: ConstructionPath[];
  /**
   * Other tools in this registry whose agreement with this one is
   * independent evidence about an encoding, per `isIndependentEvidence` in
   * `src/compat/registry.ts`. A tool sharing this one's engine without
   * reimplementing it is excluded: several tools wrapping one engine and
   * agreeing is one observation about that engine, not one per tool, and
   * this field is what stops a renderer from presenting them as peer rows
   * that each corroborate the others.
   */
  independentOf: string[];
  results: AggregateResultSummary[];
}

export interface CompatAggregate {
  formatVersion: number;
  /**
   * The most recent `testedAt` among every result carried below. Not a
   * build timestamp: it is derived from the data itself, so regenerating
   * this document from an unchanged set of result files reproduces the same
   * value rather than moving every time the generator runs.
   */
  latestTestedAt: string | null;
  engines: EngineDefinition[];
  tools: AggregateTool[];
}

function toSummary(result: CompatResult, resultsDir: string): AggregateResultSummary {
  return {
    version: result.version,
    channel: result.channel,
    path: result.path,
    testedAt: result.testedAt,
    corpusDigest: result.corpusDigest,
    arachneVersion: result.arachneVersion,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    framing: result.framing,
    summary: result.summary,
    resultFile: resultPath(result.tool, result.version, resultsDir, result.path),
  };
}

/**
 * Build the aggregate from `compat/tools.json` and every file actually
 * present under `compat/results/`. Versions and tools are discovered by
 * reading the directory rather than by assuming a fixed set: the registry
 * says which tools are tracked, and `loadResultsForTool` reads whatever
 * result files exist for each one, however many that turns out to be.
 *
 * Throws rather than silently dropping data if `resultsDir` holds a
 * directory for a tool the registry does not know about: a result file that
 * cannot be attributed to a registered tool is a state the aggregate must
 * not paper over by ignoring it.
 */
export async function buildAggregate(
  registryPath = DEFAULT_REGISTRY_PATH,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<CompatAggregate> {
  const registry = await loadToolRegistry(registryPath);

  if (existsSync(resultsDir)) {
    const present = await readdir(resultsDir, { withFileTypes: true });
    const knownIds = new Set(registry.tools.map((t) => t.id));
    for (const entry of present) {
      if (entry.isDirectory() && !knownIds.has(entry.name)) {
        throw new Error(
          `${resultsDir}/${entry.name} holds result files for a tool that is not in ${registryPath}. ` +
            'Register it, or the results under it are silently dropped from the aggregate.',
        );
      }
    }
  }

  const tools: AggregateTool[] = [];
  for (const tool of registry.tools) {
    const results = await loadResultsForTool(tool.id, resultsDir);
    tools.push({
      id: tool.id,
      displayName: tool.displayName,
      ...(tool.language === undefined ? {} : { language: tool.language }),
      ...(tool.usedFrom === undefined ? {} : { usedFrom: tool.usedFrom }),
      homepage: tool.homepage,
      engine: tool.engine,
      // Mirrors resolvePendingWork's own default in src/compat/pending.ts:
      // a tool entry that omits `paths` runs `construct` only.
      paths: tool.paths ?? ['construct'],
      independentOf: registry.tools
        .filter((other) => other.id !== tool.id && isIndependentEvidence(tool, other))
        .map((other) => other.id),
      results: results.map((r) => toSummary(r, resultsDir)),
    });
  }

  const allTestedAt = tools.flatMap((t) => t.results.map((r) => r.testedAt)).sort();
  const latestTestedAt = allTestedAt.length === 0 ? null : allTestedAt[allTestedAt.length - 1]!;

  return {
    formatVersion: AGGREGATE_FORMAT_VERSION,
    latestTestedAt,
    engines: registry.engines,
    tools,
  };
}

/** The exact bytes this project commits to `compat/aggregate.json`. */
export function serializeAggregate(aggregate: CompatAggregate): string {
  return `${JSON.stringify(aggregate, null, 2)}\n`;
}
