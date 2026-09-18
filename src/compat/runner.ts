import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '../model/json.js';
import { getAdapter } from './adapters/index.js';
import {
  classifyDecodeOutcome,
  classifyObservedOutcome,
  classifyOutcome,
  deriveFraming,
  type VectorResult,
} from './classify.js';
import { loadCompatCorpus, loadObservedCorpus, type ObservedCase } from './corpus.js';
import { getEngine, getTool, loadToolRegistry } from './registry.js';
import {
  RESULT_FORMAT_VERSION,
  summarize,
  type CompatResult,
  type ResultEngine,
} from './result-schema.js';
import type {
  Channel,
  ConstructionPath,
  DecodeItem,
  ObservedItem,
  ScriptItem,
  ToolSession,
} from './types.js';
import type { Vector } from '../vectors/schema.js';

export interface RunOptions {
  toolId: string;
  version: string;
  channel: Channel;
  arachneVersion: string;
  registryPath?: string;
  corpusDir?: string;
  /** Where the observed script set lives, for `path: 'decode-onchain'`. */
  observedScriptsPath?: string;
  /** Which construction path to exercise. Defaults to `'construct'`. */
  path?: ConstructionPath;
}

/**
 * What a run is measured against, which is not the same set on every path.
 *
 * `construct` and `decode` ask about the generated corpus; `decode-onchain`
 * asks about the observed script set in `chain-evidence/scripts.json`. A
 * result's `corpusDigest` names whichever set the run actually used, and
 * `path` is what tells a reader which of the two that is.
 */
type RunInputs =
  | { kind: 'vectors'; digest: string; vectors: Vector[] }
  | { kind: 'observed'; digest: string; cases: ObservedCase[] };

async function loadInputs(path: ConstructionPath, options: RunOptions): Promise<RunInputs> {
  if (path === 'decode-onchain') {
    const observed = await loadObservedCorpus(options.observedScriptsPath);
    return { kind: 'observed', digest: observed.digest, cases: observed.cases };
  }
  const corpus = await loadCompatCorpus(options.corpusDir);
  return { kind: 'vectors', digest: corpus.digest, vectors: corpus.vectors };
}

/**
 * Install one tool version, run it over every case the chosen path measures,
 * and return the result record. Never writes anything under `compat/results/`
 * itself; the caller decides whether and where to persist it, which keeps
 * this function usable from a script and from a test alike.
 */
export async function runCompatCheck(options: RunOptions): Promise<CompatResult> {
  const path: ConstructionPath = options.path ?? 'construct';
  const registry = await loadToolRegistry(options.registryPath);
  const tool = getTool(registry, options.toolId);
  const engineDef = getEngine(registry, tool.engine.id);
  const adapter = getAdapter(tool.adapter);
  const inputs = await loadInputs(path, options);
  const testedAt = new Date().toISOString();

  /**
   * The engine as declared, used when an install never happened so there is
   * nothing on disk to read. It records no version rather than the registry's
   * declared range, because a range is not an observation.
   */
  const declaredEngine: ResultEngine = {
    id: tool.engine.id,
    relation: tool.engine.relation,
    resolvedVersion: null,
    ...(engineDef.note === undefined ? {} : { note: engineDef.note }),
  };

  const scratchDir = await mkdtemp(join(tmpdir(), `arachne-compat-${tool.id}-`));
  try {
    const install = await adapter.install(tool, options.version, scratchDir, {
      ...(engineDef.package === undefined ? {} : { enginePackage: engineDef.package }),
    });
    if (install.status === 'failed') {
      return {
        formatVersion: RESULT_FORMAT_VERSION,
        tool: tool.id,
        version: options.version,
        channel: options.channel,
        testedAt,
        corpusDigest: inputs.digest,
        arachneVersion: options.arachneVersion,
        path,
        engine: declaredEngine,
        status: 'untested',
        reason: install.error,
        framing: null,
        vectors: [],
        summary: summarize([]),
      };
    }

    try {
      const vectors =
        inputs.kind === 'observed'
          ? await runObservedPath(tool.id, install.session, inputs.cases)
          : path === 'decode'
            ? await runDecodePath(tool.id, install.session, inputs.vectors)
            : await runConstructPath(tool.id, install.session, inputs.vectors);

      return {
        formatVersion: RESULT_FORMAT_VERSION,
        tool: tool.id,
        version: options.version,
        channel: options.channel,
        path,
        engine: await resolveEngine(install.session, declaredEngine),
        testedAt,
        corpusDigest: inputs.digest,
        arachneVersion: options.arachneVersion,
        status: 'tested',
        framing: deriveFraming(vectors, path),
        vectors,
        summary: summarize(vectors),
      };
    } finally {
      await install.session.dispose();
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** Build every vector from its JSON, hash it once, and classify the result. */
async function runConstructPath(
  toolId: string,
  session: ToolSession,
  vectors: Vector[],
): Promise<VectorResult[]> {
  const items: ScriptItem[] = vectors.map((v) => ({ id: v.id, script: parseScript(v.script) }));
  const outcomes = await session.hashScripts(items);
  return vectors.map((vector) => {
    const outcome = outcomes.get(vector.id);
    if (!outcome) {
      // The session dropped a vector rather than answering for it. That is
      // an adapter defect, not a tool finding, so it is not disguised as
      // a refusal from the tool.
      throw new Error(`adapter for "${toolId}" produced no outcome for vector "${vector.id}"`);
    }
    return classifyOutcome(vector, outcome);
  });
}

/**
 * Feed each vector's own CBOR, once per encoding, and classify both answers.
 * A vector is two questions here rather than one, so this returns twice as
 * many `VectorResult`s as vectors, each tagged with which encoding it is
 * about.
 */
async function runDecodePath(
  toolId: string,
  session: ToolSession,
  vectors: Vector[],
): Promise<VectorResult[]> {
  if (!session.decodeScripts) {
    throw new Error(
      `adapter for "${toolId}" has no decode session; "path: 'decode'" is not available for it`,
    );
  }
  const items: DecodeItem[] = vectors.map((v) => ({
    id: v.id,
    definiteCborHex: v.encoding.definite.cborHex,
    cardanoBinaryCborHex: v.encoding.cardanoBinary.cborHex,
  }));
  const outcomes = await session.decodeScripts(items);
  const results: VectorResult[] = [];
  for (const vector of vectors) {
    const outcome = outcomes.get(vector.id);
    if (!outcome) {
      throw new Error(
        `adapter for "${toolId}" produced no decode outcome for vector "${vector.id}"`,
      );
    }
    results.push(...classifyDecodeOutcome(vector, outcome));
  }
  return results;
}

/**
 * Hand over each observed byte string exactly as a transaction carried it and
 * classify the one hash that comes back.
 *
 * One question per script rather than two: these bytes exist in a single
 * framing, the one whatever software submitted them chose, and asking about a
 * second would mean re-encoding them here and testing this project's output
 * again instead of the chain's.
 */
async function runObservedPath(
  toolId: string,
  session: ToolSession,
  cases: ObservedCase[],
): Promise<VectorResult[]> {
  if (!session.hashObservedScripts) {
    throw new Error(
      `adapter for "${toolId}" has no observed-bytes session; "path: 'decode-onchain'" is not available for it`,
    );
  }
  const items: ObservedItem[] = cases.map((c) => ({ id: c.id, cborHex: c.cborHex }));
  const outcomes = await session.hashObservedScripts(items);
  return cases.map((observed) => {
    const outcome = outcomes.get(observed.id);
    if (!outcome) {
      throw new Error(
        `adapter for "${toolId}" produced no outcome for observed script "${observed.id}"`,
      );
    }
    return classifyObservedOutcome(observed, outcome);
  });
}

/**
 * Ask the session what engine version it actually installed.
 *
 * A failure to answer is recorded as a note, not as an error: knowing which
 * engine version shipped is useful, and not knowing it does not invalidate the
 * hashes the run produced.
 */
async function resolveEngine(session: ToolSession, declared: ResultEngine): Promise<ResultEngine> {
  if (!session.resolveEngineVersion) return declared;
  try {
    const resolved = await session.resolveEngineVersion();
    return {
      ...declared,
      resolvedVersion: resolved.version,
      ...(resolved.note === undefined ? {} : { note: resolved.note }),
    };
  } catch (error) {
    return {
      ...declared,
      resolvedVersion: null,
      note: `could not read the installed engine version: ${(error as Error).message}`,
    };
  }
}
