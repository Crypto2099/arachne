import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildVersionDocument,
  DEFAULT_VERSION_PATH,
  serializeVersionDocument,
  VERSION_FORMAT_VERSION,
} from '../../../src/compat/version.js';
import { AGGREGATE_FORMAT_VERSION, DEFAULT_AGGREGATE_PATH } from '../../../src/compat/aggregate.js';

// A minimal but structurally real aggregate: two tools, three results
// between them, so toolCount and resultCount below are counting something
// rather than degenerately reading zero.
function fixtureAggregateBytes(): string {
  return `${JSON.stringify(
    {
      formatVersion: AGGREGATE_FORMAT_VERSION,
      latestTestedAt: '2026-09-10T12:00:00.000Z',
      engines: [{ id: 'engine-a', displayName: 'Engine A' }],
      tools: [
        {
          id: 'tool-a',
          displayName: 'Tool A',
          homepage: 'https://example.invalid/a',
          engine: { id: 'engine-a', relation: 'depends' },
          independentOf: [],
          results: [{ version: '1.0.0' }, { version: '0.9.0' }],
        },
        {
          id: 'tool-b',
          displayName: 'Tool B',
          homepage: 'https://example.invalid/b',
          engine: { id: 'engine-a', relation: 'depends' },
          independentOf: [],
          results: [{ version: '2.0.0' }],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

describe('buildVersionDocument', () => {
  let dir: string;
  let aggregatePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arachne-compat-version-test-'));
    aggregatePath = join(dir, 'aggregate.json');
    await writeFile(aggregatePath, fixtureAggregateBytes(), 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries latestTestedAt from the aggregate unchanged', async () => {
    const doc = await buildVersionDocument(aggregatePath);
    expect(doc.latestTestedAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('counts tools and results across every tool, not just the first', async () => {
    const doc = await buildVersionDocument(aggregatePath);
    expect(doc.toolCount).toBe(2);
    expect(doc.resultCount).toBe(3);
  });

  // The digest exists to catch a change latestTestedAt would miss: a result
  // removed, or an engine relation edited in compat/tools.json, with no new
  // test run. It has to be a hash of the bytes a consumer actually fetches,
  // not a value recomputed from the parsed structure, or a change with no
  // effect on the parsed shape (key order, for instance) would go unnoticed
  // even though the served file itself changed.
  it('hashes the aggregate file bytes exactly as sha256, independent of this module', async () => {
    const bytes = await readFile(aggregatePath);
    const expected = createHash('sha256').update(bytes).digest('hex');

    const doc = await buildVersionDocument(aggregatePath);

    expect(doc.aggregateDigest).toBe(expected);
    expect(doc.aggregateDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest when the aggregate bytes change, even if the parsed counts do not', async () => {
    const before = await buildVersionDocument(aggregatePath);

    // Reformatted whitespace only: same tools, same results, different bytes.
    const reformatted = fixtureAggregateBytes().replace(/\n/g, '\n ');
    await writeFile(aggregatePath, reformatted, 'utf8');
    const after = await buildVersionDocument(aggregatePath);

    expect(after.toolCount).toBe(before.toolCount);
    expect(after.resultCount).toBe(before.resultCount);
    expect(after.aggregateDigest).not.toBe(before.aggregateDigest);
  });

  it('carries its own formatVersion', async () => {
    const doc = await buildVersionDocument(aggregatePath);
    expect(doc.formatVersion).toBe(VERSION_FORMAT_VERSION);
  });
});

describe('serializeVersionDocument', () => {
  it('is byte-stable: serializing the same document twice produces identical bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arachne-compat-version-test-'));
    try {
      const aggregatePath = join(dir, 'aggregate.json');
      await writeFile(aggregatePath, fixtureAggregateBytes(), 'utf8');

      const first = serializeVersionDocument(await buildVersionDocument(aggregatePath));
      const second = serializeVersionDocument(await buildVersionDocument(aggregatePath));

      expect(first).toBe(second);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not carry a generatedAt or any other wall-clock field', () => {
    const serialized = serializeVersionDocument({
      formatVersion: VERSION_FORMAT_VERSION,
      latestTestedAt: '2026-09-10T12:00:00.000Z',
      aggregateDigest: 'a'.repeat(64),
      toolCount: 1,
      resultCount: 1,
    });
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(
      ['aggregateDigest', 'formatVersion', 'latestTestedAt', 'resultCount', 'toolCount'].sort(),
    );
  });
});

describe('the committed version document', () => {
  // Mirrors test/unit/compat/aggregate.test.ts's "matches what the generator
  // produces today": a hand edit, or a stale file left behind after
  // compat/aggregate.json changed underneath it, fails here as well as in
  // "npm run compat:version:check".
  it('matches what compat/aggregate.json produces right now', async () => {
    const doc = await buildVersionDocument(DEFAULT_AGGREGATE_PATH);
    const onDisk = await readFile(DEFAULT_VERSION_PATH, 'utf8');
    expect(serializeVersionDocument(doc)).toBe(onDisk);
  });
});
