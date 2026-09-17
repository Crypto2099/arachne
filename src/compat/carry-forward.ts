import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Copy every result file present under `sourceDir` but not already present
 * under `targetDir`, preserving the `<tool>/<version[-decode]>.json` layout.
 *
 * This is the compat corpus's version of what `writeCorpus` already does for
 * `onchain`: carry an existing observation forward by its own identity (here,
 * its path) instead of letting a rebuild silently drop it. The caller points
 * `sourceDir` at a checkout of the still-open `upstream-watch/results` branch
 * and `targetDir` at the working tree's `compat/results`, so a result already
 * recorded there and not yet merged to `main` is folded back in before the
 * watcher decides what is still pending, rather than being rebuilt away when
 * that branch is next force-pushed from `main`.
 *
 * Never overwrites a file already under `targetDir`: that copy is whatever
 * `main` already carries, and the only job here is filling in what `main`
 * does not have yet.
 */
export async function carryForwardResults(sourceDir: string, targetDir: string): Promise<string[]> {
  if (!existsSync(sourceDir)) return [];

  const copied: string[] = [];
  for (const toolDir of await readdir(sourceDir, { withFileTypes: true })) {
    if (!toolDir.isDirectory()) continue;
    const sourceToolDir = join(sourceDir, toolDir.name);
    const targetToolDir = join(targetDir, toolDir.name);
    for (const file of await readdir(sourceToolDir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const targetPath = join(targetToolDir, file.name);
      if (existsSync(targetPath)) continue;
      await mkdir(targetToolDir, { recursive: true });
      await copyFile(join(sourceToolDir, file.name), targetPath);
      copied.push(join(toolDir.name, file.name));
    }
  }
  return copied;
}

export interface OpenPullRequestCheck {
  owner: string;
  repo: string;
  branch: string;
  token?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Whether GitHub currently has an open pull request whose head is `branch`.
 *
 * `peter-evans/create-pull-request` deletes a branch, closing whatever pull
 * request is open on it, when a force-push leaves that branch with no diff
 * against base (its own README states this). A scheduled run that force-pushes
 * `upstream-watch/results` from a fresh checkout of `main` must know, before it
 * does that, whether a pull request is already open there, because that is
 * exactly the case where results committed on the branch and not yet merged
 * would otherwise be discarded. Restricted to `state=open` and this exact
 * head, so a closed or merged pull request from an earlier run never counts.
 */
export async function hasOpenPullRequestForBranch(check: OpenPullRequestCheck): Promise<boolean> {
  const { owner, repo, branch, token, fetchImpl = fetch } = check;
  const head = encodeURIComponent(`${owner}:${branch}`);
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${head}&state=open`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'arachne-compat-watch',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${body.slice(0, 300)}`);
  }
  const pulls = JSON.parse(body) as unknown[];
  return pulls.length > 0;
}
