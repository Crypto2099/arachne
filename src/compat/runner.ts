import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '../model/json.js';
import { getAdapter } from './adapters/index.js';
import { classifyOutcome, deriveFraming } from './classify.js';
import { loadCompatCorpus } from './corpus.js';
import { getTool, loadToolRegistry } from './registry.js';
import { RESULT_FORMAT_VERSION, summarize, type CompatResult } from './result-schema.js';
import type { Channel, ScriptItem } from './types.js';

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
  const adapter = getAdapter(tool.adapter);
  const corpus = await loadCompatCorpus(options.corpusDir);
  const testedAt = new Date().toISOString();

  const scratchDir = await mkdtemp(join(tmpdir(), `arachne-compat-${tool.id}-`));
  try {
    const install = await adapter.install(tool, options.version, scratchDir);
    if (install.status === 'failed') {
      return {
        formatVersion: RESULT_FORMAT_VERSION,
        tool: tool.id,
        version: options.version,
        channel: options.channel,
        testedAt,
        corpusDigest: corpus.digest,
        arachneVersion: options.arachneVersion,
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
