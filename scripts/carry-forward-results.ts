#!/usr/bin/env node
// Runs before scripts/compat-watch.ts in the scheduled workflow, so that its
// pending-work detection sees whatever compat/results already exist on an
// open upstream-watch/results pull request. Without this, resolvePendingWork
// only ever looks at the checkout of main it was given, so a result recorded
// on that branch and not yet merged is invisible to it: the watcher reruns
// the version as if it were untested, and the workflow's next force-push
// rebuilds the branch from main and discards whatever was there before,
// including versions that may since have aged out of the channels the
// registry tracks and so would never be regenerated.
//
// Skips cleanly, doing nothing, when GITHUB_REPOSITORY is unset (not running
// under Actions), when upstream-watch/results does not exist on origin, or
// when it exists but has no open pull request.
//
// `--out <file>` writes the paths it copied, relative to compat/results, as a
// JSON array, and writes an empty array when it skips. scripts/compat-watch.ts
// reads that file through its own `--carried` flag, so the pull request it
// describes lists the results carried forward here alongside the ones it
// tested itself, rather than only the latter.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  carryForwardResults,
  exportPathFromRef,
  hasOpenPullRequestForBranch,
} from '../src/compat/carry-forward.js';
import { DEFAULT_RESULTS_DIR } from '../src/compat/results.js';

const BRANCH = 'upstream-watch/results';

async function main(argv: string[]): Promise<number> {
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : argv[outIndex + 1];
  if (outIndex !== -1 && !out) throw new Error('--out needs a file path');

  const copied = await carryForward();
  if (out) await writeFile(out, `${JSON.stringify(copied, null, 2)}\n`, 'utf8');
  return 0;
}

async function carryForward(): Promise<string[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY is not set; skipping carry-forward');
    return [];
  }
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    console.error(`GITHUB_REPOSITORY "${repo}" is not "owner/repo"; skipping carry-forward`);
    return [];
  }

  if (!remoteBranchExists(BRANCH)) {
    console.error(`no "${BRANCH}" branch on origin; nothing to carry forward`);
    return [];
  }

  const token = process.env.GITHUB_TOKEN;
  const hasOpenPr = await hasOpenPullRequestForBranch({
    owner,
    repo: name,
    branch: BRANCH,
    ...(token !== undefined && { token }),
  });
  if (!hasOpenPr) {
    console.error(`"${BRANCH}" exists but has no open pull request; nothing to carry forward`);
    return [];
  }

  const scratch = await mkdtemp(join(tmpdir(), 'arachne-carry-forward-'));
  try {
    execFileSync('git', ['fetch', 'origin', `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], {
      stdio: 'inherit',
    });
    const exported = exportPathFromRef({
      ref: `refs/remotes/origin/${BRANCH}`,
      path: DEFAULT_RESULTS_DIR,
      into: scratch,
    });

    const copied = await carryForwardResults(exported, DEFAULT_RESULTS_DIR);
    console.error(
      copied.length === 0
        ? `"${BRANCH}" had nothing not already on disk`
        : `carried forward ${copied.length} result file(s) from "${BRANCH}":\n${copied
            .map((p) => `  ${p}`)
            .join('\n')}`,
    );
    return copied;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * `git ls-remote --exit-code` returns 2 specifically when the ref is not
 * present (documented in git-ls-remote(1)); any other failure, such as a
 * network or auth error, is a real problem and is left to propagate rather
 * than being read as "branch absent", since silently treating it that way
 * would rebuild upstream-watch/results from main and reproduce exactly the
 * data loss this script exists to prevent.
 */
function remoteBranchExists(branch: string): boolean {
  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (status === 2) return false;
    throw error;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
