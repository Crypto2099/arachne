import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  carryForwardResults,
  hasOpenPullRequestForBranch,
} from '../../../src/compat/carry-forward.js';

describe('carryForwardResults', () => {
  let source: string;
  let target: string;

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'arachne-carry-forward-source-'));
    target = await mkdtemp(join(tmpdir(), 'arachne-carry-forward-target-'));
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it('copies a result present on the branch but not yet in the working tree', async () => {
    await mkdir(join(source, 'gouroboros'), { recursive: true });
    await writeFile(join(source, 'gouroboros', '0.205.0.json'), '{"version":"0.205.0"}\n', 'utf8');

    const copied = await carryForwardResults(source, target);

    expect(copied).toEqual(['gouroboros/0.205.0.json']);
    await expect(readFile(join(target, 'gouroboros', '0.205.0.json'), 'utf8')).resolves.toBe(
      '{"version":"0.205.0"}\n',
    );
  });

  // This is the guard against a rebuild clobbering whatever main already
  // carries: the branch is always rebuilt from main, so main's own copy of a
  // result is at least as current as the branch's, and this function's only
  // job is filling in what main does not have yet.
  it('never overwrites a file already present in the working tree', async () => {
    await mkdir(join(source, 'gouroboros'), { recursive: true });
    await writeFile(join(source, 'gouroboros', '0.205.0.json'), '{"from":"branch"}\n', 'utf8');
    await mkdir(join(target, 'gouroboros'), { recursive: true });
    await writeFile(join(target, 'gouroboros', '0.205.0.json'), '{"from":"main"}\n', 'utf8');

    const copied = await carryForwardResults(source, target);

    expect(copied).toEqual([]);
    await expect(readFile(join(target, 'gouroboros', '0.205.0.json'), 'utf8')).resolves.toBe(
      '{"from":"main"}\n',
    );
  });

  it('copies only the files missing from the working tree, from a directory holding both', async () => {
    await mkdir(join(source, 'gouroboros'), { recursive: true });
    await writeFile(join(source, 'gouroboros', '0.205.0.json'), '{"version":"0.205.0"}\n', 'utf8');
    await writeFile(join(source, 'gouroboros', '0.205.3.json'), '{"version":"0.205.3"}\n', 'utf8');
    await mkdir(join(target, 'gouroboros'), { recursive: true });
    await writeFile(join(target, 'gouroboros', '0.205.0.json'), '{"version":"0.205.0"}\n', 'utf8');

    const copied = await carryForwardResults(source, target);

    expect(copied).toEqual(['gouroboros/0.205.3.json']);
  });

  it('returns no files and does not throw when the source directory does not exist', async () => {
    const copied = await carryForwardResults(join(source, 'does-not-exist'), target);
    expect(copied).toEqual([]);
  });
});

describe('hasOpenPullRequestForBranch', () => {
  it('is true when the API lists an open pull request for that head', async () => {
    const fetchImpl = async (url: string | URL) => {
      expect(String(url)).toContain('head=owner%3Aupstream-watch%2Fresults');
      expect(String(url)).toContain('state=open');
      return new Response(JSON.stringify([{ number: 22 }]), { status: 200 });
    };

    const result = await hasOpenPullRequestForBranch({
      owner: 'owner',
      repo: 'repo',
      branch: 'upstream-watch/results',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toBe(true);
  });

  it('is false when the API lists no open pull request for that head', async () => {
    const fetchImpl = async () => new Response(JSON.stringify([]), { status: 200 });

    const result = await hasOpenPullRequestForBranch({
      owner: 'owner',
      repo: 'repo',
      branch: 'upstream-watch/results',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toBe(false);
  });

  it('throws, rather than reading as "no pull request", when the API call itself fails', async () => {
    const fetchImpl = async () => new Response('bad credentials', { status: 401 });

    await expect(
      hasOpenPullRequestForBranch({
        owner: 'owner',
        repo: 'repo',
        branch: 'upstream-watch/results',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/401/);
  });
});
