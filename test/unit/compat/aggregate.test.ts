import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGGREGATE_FORMAT_VERSION,
  buildAggregate,
  DEFAULT_AGGREGATE_PATH,
  serializeAggregate,
} from '../../../src/compat/aggregate.js';
import { writeCompatResult, resultPath } from '../../../src/compat/results.js';
import { RESULT_FORMAT_VERSION, type CompatResult } from '../../../src/compat/result-schema.js';

const FIXTURE_REGISTRY = 'test/unit/compat/fixtures/aggregate-registry.json';

function result(
  overrides: Partial<CompatResult> & Pick<CompatResult, 'tool' | 'version'>,
): CompatResult {
  return {
    formatVersion: RESULT_FORMAT_VERSION,
    channel: 'current',
    path: 'construct',
    engine: { id: 'shared-engine', relation: 'depends', resolvedVersion: null },
    testedAt: '2026-01-01T00:00:00.000Z',
    corpusDigest: 'digest',
    arachneVersion: 'arachne@0.1.0',
    status: 'tested',
    framing: 'definite',
    vectors: [],
    summary: { total: 0, agreed: 0, diverged: 0, refused: 0, unsupported: 0 },
    ...overrides,
  };
}

describe('buildAggregate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arachne-compat-aggregate-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries the corpusDigest each result was tested against, unchanged', async () => {
    await writeCompatResult(
      result({ tool: 'tool-a', version: '1.0.0', corpusDigest: 'digest-one' }),
      dir,
    );
    await writeCompatResult(
      result({ tool: 'tool-b', version: '1.0.0', corpusDigest: 'digest-two' }),
      dir,
    );

    const aggregate = await buildAggregate(FIXTURE_REGISTRY, dir);
    const toolA = aggregate.tools.find((t) => t.id === 'tool-a');
    const toolB = aggregate.tools.find((t) => t.id === 'tool-b');

    // Two results here were never tested against the same corpus build, so a
    // reader must be able to tell that apart without opening either result
    // file: compat/README.md says two results are only directly comparable
    // when this field matches.
    expect(toolA?.results[0]?.corpusDigest).toBe('digest-one');
    expect(toolB?.results[0]?.corpusDigest).toBe('digest-two');
  });

  it('does not flatten a mixed or undetermined framing into a neighboring value', async () => {
    await writeCompatResult(result({ tool: 'tool-a', version: '1.0.0', framing: 'mixed' }), dir);
    await writeCompatResult(
      result({ tool: 'tool-b', version: '1.0.0', framing: 'undetermined' }),
      dir,
    );

    const aggregate = await buildAggregate(FIXTURE_REGISTRY, dir);
    const toolA = aggregate.tools.find((t) => t.id === 'tool-a');
    const toolB = aggregate.tools.find((t) => t.id === 'tool-b');

    // A "mixed" or "undetermined" reading on one version is exactly the
    // finding this document exists to surface, so it must survive
    // aggregation verbatim rather than being averaged toward a cleaner value.
    expect(toolA?.results[0]?.framing).toBe('mixed');
    expect(toolB?.results[0]?.framing).toBe('undetermined');
  });

  it('does not count two tools sharing one engine as independent evidence of each other', async () => {
    const aggregate = await buildAggregate(FIXTURE_REGISTRY, dir);
    const toolA = aggregate.tools.find((t) => t.id === 'tool-a');

    // tool-a and tool-b both sit on shared-engine with relation "depends":
    // agreeing is one observation about that engine, not two, so neither
    // corroborates the other.
    expect(toolA?.independentOf).not.toContain('tool-b');

    // tool-c sits on the same engine but reimplements the rule rather than
    // inheriting it, so its agreement with tool-a is real corroboration.
    expect(toolA?.independentOf).toContain('tool-c');

    // tool-d sits on a wholly different engine.
    expect(toolA?.independentOf).toContain('tool-d');
  });

  it('names the exact result file a summary was read from', async () => {
    await writeCompatResult(result({ tool: 'tool-a', version: '1.2.3' }), dir);

    const aggregate = await buildAggregate(FIXTURE_REGISTRY, dir);
    const toolA = aggregate.tools.find((t) => t.id === 'tool-a');

    expect(toolA?.results[0]?.resultFile).toBe(resultPath('tool-a', '1.2.3', dir, 'construct'));
  });

  it('includes a tool with no results yet as an empty list, not an absence', async () => {
    const aggregate = await buildAggregate(FIXTURE_REGISTRY, dir);
    const toolD = aggregate.tools.find((t) => t.id === 'tool-d');
    expect(toolD?.results).toEqual([]);
  });

  it('throws rather than silently dropping results for a tool the registry does not know', async () => {
    await mkdir(join(dir, 'unregistered-tool'), { recursive: true });
    await writeCompatResult(result({ tool: 'unregistered-tool', version: '1.0.0' }), dir);

    await expect(buildAggregate(FIXTURE_REGISTRY, dir)).rejects.toThrow(/unregistered-tool/);
  });

  it("carries its own formatVersion, distinct from a result file's", () => {
    expect(AGGREGATE_FORMAT_VERSION).not.toBe(RESULT_FORMAT_VERSION);
  });
});

describe('the committed aggregate', () => {
  // Mirrors test/conformance/corpus.test.ts's "matches what the generator
  // produces today": a hand edit, or a result file added without rerunning
  // "npm run compat:aggregate", fails here as well as in CI.
  it('matches what compat/tools.json and compat/results/ produce right now', async () => {
    const aggregate = await buildAggregate();
    const onDisk = await readFile(DEFAULT_AGGREGATE_PATH, 'utf8');
    expect(serializeAggregate(aggregate)).toBe(onDisk);
  });
});
