import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '../model/json.js';
import { getAdapter } from './adapters/index.js';
import {
  classifyDecodeOutcome,
  classifyOutcome,
  deriveFraming,
  type VectorResult,
} from './classify.js';
import { loadCompatCorpus } from './corpus.js';
import { getEngine, getTool, loadToolRegistry } from './registry.js';
import {
  RESULT_FORMAT_VERSION,
  summarize,
  type CompatResult,
  type ResultEngine,
} from './result-schema.js';
import type { Channel, ConstructionPath, DecodeItem, ScriptItem, ToolSession } from './types.js';
import type { Vector } from '../vectors/schema.js';

export interface RunOptions {
  toolId: string;
  version: string;
  channel: Channel;
  arachneVersion: string;
  registryPath?: string;
  corpusDir?: string;
  /** Which construction path to exercise. Defaults to `'construct'`. */
  path?: ConstructionPath;
}

/**
 * Install one tool version, run it over the whole committed corpus, and
 * return the result record. Never writes anything under `compat/results/`
 * itself; the caller decides whether and where to persist it, which keeps
 * this function usable from a script and from a test alike.
 */
export async function runCompatCheck(options: RunOptions): Promise<CompatResult> {
  const path: ConstructionPath = options.path ?? 'construct';
  const registry = await loadToolRegistry(options.registryPath);
  const tool = getTool(registry, options.toolId);
  const engineDef = getEngine(registry, tool.engine.id);
  const adapter = getAdapter(tool.adapter);
  const corpus = await loadCompatCorpus(options.corpusDir);
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
        corpusDigest: corpus.digest,
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
        path === 'decode'
          ? await runDecodePath(tool.id, install.session, corpus.vectors)
          : await runConstructPath(tool.id, install.session, corpus.vectors);

      return {
        formatVersion: RESULT_FORMAT_VERSION,
        tool: tool.id,
        version: options.version,
        channel: options.channel,
        path,
        engine: await resolveEngine(install.session, declaredEngine),
        testedAt,
        corpusDigest: corpus.digest,
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
