import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '../model/json.js';
import { getAdapter } from './adapters/index.js';
import { classifyOutcome, deriveFraming } from './classify.js';
import { loadCompatCorpus } from './corpus.js';
import { getEngine, getTool, loadToolRegistry } from './registry.js';
import {
  RESULT_FORMAT_VERSION,
  summarize,
  type CompatResult,
  type ResultEngine,
} from './result-schema.js';
import type { Channel, ScriptItem, ToolSession } from './types.js';

export interface RunOptions {
  toolId: string;
  version: string;
  channel: Channel;
  arachneVersion: string;
  registryPath?: string;
  corpusDir?: string;
}

/**
 * Install one tool version, run it over the whole committed corpus, and
 * return the result record. Never writes anything under `compat/results/`
 * itself; the caller decides whether and where to persist it, which keeps
 * this function usable from a script and from a test alike.
 */
export async function runCompatCheck(options: RunOptions): Promise<CompatResult> {
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
        path: 'construct',
        engine: declaredEngine,
        status: 'untested',
        reason: install.error,
        framing: null,
        vectors: [],
        summary: summarize([]),
      };
    }

    try {
      const items: ScriptItem[] = corpus.vectors.map((v) => ({
        id: v.id,
        script: parseScript(v.script),
      }));
      const outcomes = await install.session.hashScripts(items);
      const vectors = corpus.vectors.map((vector) => {
        const outcome = outcomes.get(vector.id);
        if (!outcome) {
          // The session dropped a vector rather than answering for it. That is
          // an adapter defect, not a tool finding, so it is not disguised as
          // a refusal from the tool.
          throw new Error(`adapter for "${tool.id}" produced no outcome for vector "${vector.id}"`);
        }
        return classifyOutcome(vector, outcome);
      });

      return {
        formatVersion: RESULT_FORMAT_VERSION,
        tool: tool.id,
        version: options.version,
        channel: options.channel,
        // Every adapter here builds a script and hashes the result. A decode
        // path, feeding a tool existing CBOR, is a different question and gets
        // its own runs rather than being folded into this number.
        path: 'construct',
        engine: await resolveEngine(install.session, declaredEngine),
        testedAt,
        corpusDigest: corpus.digest,
        arachneVersion: options.arachneVersion,
        status: 'tested',
        framing: deriveFraming(vectors),
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
