#!/usr/bin/env node
// The upstream watcher's entry point, and the one the workflow calls.
//
// `--dry-run` resolves what is pending and stops there, writing neither a
// result file nor a real PR title/body. It is meant to be run locally
// (`npx tsx scripts/compat-watch.ts --dry-run`) to answer "what would today's
// scheduled run do" without installing anything, and it is what
// `workflow_dispatch` should be pointed at before trusting an unattended run.
//
// Without the flag, it runs every pending (tool, channel, path), writes
// `compat/results/<tool>/<version>.json` (or `<version>-<path>.json` for a
// tool registered against more than one path) for each, and writes a PR title and
// body describing what it found: `pr-title.txt` states whether a behavior
// change was found, and `pr-body.md` lists every version tested with its
// change report against the version it replaces.
//
// `--carried <file>` names the JSON array scripts/carry-forward-results.ts
// writes: result files, relative to compat/results, copied from a pull
// request that was already open. The workflow rebuilds that pull request from
// this run's working tree and replaces its title and body with the ones
// written here, so they have to describe every result the branch will carry,
// not only the ones tested in this run. Without the flag nothing is carried.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arachneVersion } from '../src/compat/arachne-version.js';
import { compareResults } from '../src/compat/change.js';
import type { PendingItem } from '../src/compat/pending.js';
import { resolvePendingWork } from '../src/compat/pending.js';
import { loadToolRegistry } from '../src/compat/registry.js';
import { runCompatCheck } from '../src/compat/runner.js';
import type { CompatResult } from '../src/compat/result-schema.js';
import { DEFAULT_RESULTS_DIR, previousResult, writeCompatResult } from '../src/compat/results.js';
import type { ConstructionPath } from '../src/compat/types.js';

interface RanItem {
  tool: string;
  version: string;
  channel: string;
  path: ConstructionPath;
  /** Where the result was written, on disk. */
  filePath: string;
  status: string;
  framing: string | null;
  changed: boolean;
  hadBaseline: boolean;
  headline: string;
  details: string[];
  /**
   * When this result was recorded by an earlier run and carried forward from
   * the open pull request, that run's `testedAt`; absent for a result this
   * run tested.
   */
  carriedFrom?: string;
}

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const titleOut = argOf(argv, '--title-out') ?? 'compat-watch-title.txt';
  const bodyOut = argOf(argv, '--body-out') ?? 'compat-watch-body.md';
  const carriedIn = argOf(argv, '--carried');
  if (argv.includes('--carried') && !carriedIn) throw new Error('--carried needs a file path');

  const registry = await loadToolRegistry();
  const pending = await resolvePendingWork(registry);

  console.error(pending.length === 0 ? 'nothing pending' : `${pending.length} pending:`);
  for (const item of pending) {
    console.error(`  ${item.tool} ${item.version} (${item.channel}, ${item.path})`);
  }

  if (dryRun) {
    await writeFile(titleOut, 'compat: dry run, nothing written', 'utf8');
    await writeFile(bodyOut, renderBody(pending, [], [], dryRun), 'utf8');
    console.log(JSON.stringify({ pending, ran: [], carried: [], anyChanged: false }));
    return 0;
  }

  const carried = carriedIn ? await describeCarried(carriedIn) : [];

  if (pending.length === 0 && carried.length === 0) {
    await writeFile(titleOut, 'compat: nothing new', 'utf8');
    await writeFile(bodyOut, renderBody(pending, [], [], false), 'utf8');
    console.log(JSON.stringify({ pending, ran: [], carried: [], anyChanged: false }));
    return 0;
  }

  const version = await arachneVersion();
  const ran: RanItem[] = [];
  for (const item of pending) {
    console.error(`running ${item.tool} ${item.version} (${item.path})...`);
    const result = await runCompatCheck({
      toolId: item.tool,
      version: item.version,
      channel: item.channel,
      arachneVersion: version,
      path: item.path,
    });
    const previous = await previousResult(item.tool, item.version, undefined, item.path);
    const change = compareResults(result, previous);
    const filePath = await writeCompatResult(result);
    ran.push({
      tool: item.tool,
      version: item.version,
      channel: item.channel,
      path: item.path,
      filePath,
      status: result.status,
      framing: result.framing,
      changed: change.changed,
      hadBaseline: change.hadBaseline,
      headline: change.headline,
      details: change.details,
    });
    console.error(change.headline);
    for (const detail of change.details) console.error(`  ${detail}`);
  }

  const all = [...carried, ...ran];
  const anyChanged = all.some((r) => r.changed);
  await writeFile(titleOut, buildTitle(all, anyChanged), 'utf8');
  await writeFile(bodyOut, renderBody(pending, ran, carried, false), 'utf8');

  console.log(JSON.stringify({ pending, ran, carried, anyChanged }));
  return 0;
}

/**
 * Read each carried result back from compat/results and compare it with the
 * version it replaces, the same comparison a fresh run makes, so a behavior
 * change found by an earlier run stays in the title and body after this run
 * rewrites them.
 */
async function describeCarried(listFile: string): Promise<RanItem[]> {
  const paths = JSON.parse(await readFile(listFile, 'utf8')) as string[];
  const items: RanItem[] = [];
  for (const relative of paths) {
    const filePath = join(DEFAULT_RESULTS_DIR, relative);
    const result = JSON.parse(await readFile(filePath, 'utf8')) as CompatResult;
    const previous = await previousResult(result.tool, result.version, undefined, result.path);
    const change = compareResults(result, previous);
    items.push({
      tool: result.tool,
      version: result.version,
      channel: result.channel,
      path: result.path,
      filePath,
      status: result.status,
      framing: result.framing,
      changed: change.changed,
      hadBaseline: change.hadBaseline,
      headline: change.headline,
      details: change.details,
      carriedFrom: result.testedAt,
    });
  }
  return items;
}

function argOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function buildTitle(ran: RanItem[], anyChanged: boolean): string {
  if (ran.length === 1) {
    const r = ran[0]!;
    return anyChanged
      ? `compat: ${r.tool} ${r.version} behaves differently from the last recorded version`
      : `compat: record ${r.tool} ${r.version} (${r.channel})`;
  }
  return anyChanged
    ? `compat: upstream watch found a behavior change (${ran.length} versions tested)`
    : `compat: record ${ran.length} new upstream versions`;
}

function summaryLine(ran: RanItem[]): string {
  const withBaseline = ran.filter((r) => r.hadBaseline);
  const changed = withBaseline.filter((r) => r.changed);
  const firstEver = ran.length - withBaseline.length;

  const parts: string[] = [];
  if (withBaseline.length > 0) {
    parts.push(
      changed.length > 0
        ? `${changed.length} of ${withBaseline.length} tested version${withBaseline.length === 1 ? '' : 's'} behave differently from the version they replace.`
        : `All ${withBaseline.length} tested version${withBaseline.length === 1 ? '' : 's'} behave the same as the version they replace.`,
    );
  }
  if (firstEver > 0) {
    parts.push(
      `${firstEver} tested version${firstEver === 1 ? '' : 's'} had no earlier recorded version to compare against.`,
    );
  }
  return parts.join(' ');
}

function renderBody(
  pending: PendingItem[],
  ran: RanItem[],
  carried: RanItem[],
  dryRun: boolean,
): string {
  const lines: string[] = [];
  if (dryRun) lines.push('Dry run. No result file was written and no version was installed.', '');

  if (pending.length === 0 && carried.length === 0) {
    lines.push('No new version was found on any tracked channel for any registered tool.');
    return lines.join('\n');
  }

  if (dryRun) {
    lines.push('Versions that would be tested:', '');
    for (const item of pending) {
      lines.push(`- ${item.tool} ${item.version} (${item.channel}, ${item.path})`);
    }
    return lines.join('\n');
  }

  lines.push(summaryLine([...carried, ...ran]), '');

  for (const r of [...carried, ...ran]) {
    lines.push(`### ${r.tool} ${r.version} (${r.channel}, ${r.path})`, '');
    if (r.carriedFrom) {
      lines.push(`Tested ${r.carriedFrom} by an earlier run and carried forward.`, '');
    }
    lines.push(`Status: ${r.status}${r.framing ? `, framing ${r.framing}` : ''}`);
    lines.push(r.headline);
    for (const detail of r.details) lines.push(`- ${detail}`);
    lines.push('');
  }
  return lines.join('\n');
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
