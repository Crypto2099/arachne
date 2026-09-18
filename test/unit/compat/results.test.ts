import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previousResult, resultPath, writeCompatResult } from '../../../src/compat/results.js';
import type { CompatResult } from '../../../src/compat/result-schema.js';

function result(version: string, path: CompatResult['path']): CompatResult {
  return {
    formatVersion: 2,
    tool: 'gouroboros',
    version,
    channel: 'current',
    path,
    engine: { id: 'gouroboros', relation: 'own', resolvedVersion: version },
    testedAt: '2026-01-01T00:00:00.000Z',
    corpusDigest: 'digest',
    arachneVersion: 'arachne@0.1.0',
    status: 'tested',
    framing: path === 'decode' ? 'framing-preserving' : 'definite',
    vectors: [],
    summary: { total: 0, agreed: 0, diverged: 0, refused: 0, unsupported: 0 },
  };
}

describe('resultPath', () => {
  it('names a construct result with the bare version, unchanged from before decode existed', () => {
    expect(resultPath('cardano-cli', '11.2.3.1')).toBe('compat/results/cardano-cli/11.2.3.1.json');
    expect(resultPath('gouroboros', '0.205.1', 'compat/results', 'construct')).toBe(
      'compat/results/gouroboros/0.205.1.json',
    );
  });

  // The same version can be run on both paths (gouroboros is), and each is
  // its own committed file, so the two must never collide on a filename.
  it('gives the decode path its own suffixed name', () => {
    expect(resultPath('gouroboros', '0.205.1', 'compat/results', 'decode')).toBe(
      'compat/results/gouroboros/0.205.1-decode.json',
    );
  });

  it('gives the observed-bytes path its own suffixed name', () => {
    expect(resultPath('gouroboros', '0.205.1', 'compat/results', 'decode-onchain')).toBe(
      'compat/results/gouroboros/0.205.1-decode-onchain.json',
    );
  });
});

describe('writeCompatResult and previousResult', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arachne-compat-results-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a construct result and a decode result for the same version to different files', async () => {
    const construct = await writeCompatResult(result('0.205.1', 'construct'), dir);
    const decode = await writeCompatResult(result('0.205.1', 'decode'), dir);
    expect(construct).not.toBe(decode);
    expect(construct.endsWith('0.205.1.json')).toBe(true);
    expect(decode.endsWith('0.205.1-decode.json')).toBe(true);
  });

  it('finds the previous version on the same path only', async () => {
    await writeCompatResult(result('0.204.7', 'construct'), dir);
    await writeCompatResult(result('0.204.7', 'decode'), dir);
    await writeCompatResult(result('0.205.0', 'construct'), dir);
    await writeCompatResult(result('0.205.0', 'decode'), dir);

    const previousConstruct = await previousResult('gouroboros', '0.205.1', dir, 'construct');
    const previousDecode = await previousResult('gouroboros', '0.205.1', dir, 'decode');

    // Neither lookup should ever cross paths: a decode result is never the
    // "previous version" of a construct result, even when both exist for the
    // exact version immediately below.
    expect(previousConstruct?.version).toBe('0.205.0');
    expect(previousConstruct?.path).toBe('construct');
    expect(previousDecode?.version).toBe('0.205.0');
    expect(previousDecode?.path).toBe('decode');
  });

  it('defaults to the construct path when none is given, matching every tool registered before decode existed', async () => {
    await writeCompatResult(result('0.204.7', 'construct'), dir);
    const previous = await previousResult('gouroboros', '0.205.0', dir);
    expect(previous?.path).toBe('construct');
  });
});
