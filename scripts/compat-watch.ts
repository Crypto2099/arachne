#!/usr/bin/env node
// The upstream watcher's entry point, and the one the workflow calls.
//
// `--dry-run` resolves what is pending and stops there, writing neither a
// result file nor a real PR title/body. It is meant to be run locally
// (`npx tsx scripts/compat-watch.ts --dry-run`) to answer "what would today's
// scheduled run do" without installing anything, and it is what
// `workflow_dispatch` should be pointed at before trusting an unattended run.
//
// Without the flag, it runs every pending (tool, channel), writes
// `compat/results/<tool>/<version>.json` for each, and writes a PR title and
// body describing what it found: `pr-title.txt` states whether a behavior
// change was found, and `pr-body.md` lists every version tested with its
// change report against the version it replaces.
import { writeFile } from 'node:fs/promises';
import { arachneVersion } from '../src/compat/arachne-version.js';
import { compareResults } from '../src/compat/change.js';
import type { PendingItem } from '../src/compat/pending.js';
import { resolvePendingWork } from '../src/compat/pending.js';
import { loadToolRegistry } from '../src/compat/registry.js';
import { runCompatCheck } from '../src/compat/runner.js';
import { previousResult, writeCompatResult } from '../src/compat/results.js';

interface RanItem {
  tool: string;
  version: string;
  channel: string;
  path: string;
  status: string;
  framing: string | null;
  changed: boolean;
  hadBaseline: boolean;
  headline: string;
  details: string[];
}

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const titleOut = argOf(argv, '--title-out') ?? 'compat-watch-title.txt';
  const bodyOut = argOf(argv, '--body-out') ?? 'compat-watch-body.md';

  const registry = await loadToolRegistry();
  const pending = await resolvePendingWork(registry);

  console.error(pending.length === 0 ? 'nothing pending' : `${pending.length} pending:`);
  for (const item of pending) console.error(`  ${item.tool} ${item.version} (${item.channel})`);

  if (dryRun || pending.length === 0) {
    await writeFile(
      titleOut,
      dryRun ? 'compat: dry run, nothing written' : 'compat: nothing new',
      'utf8',
    );
    await writeFile(bodyOut, renderBody(pending, [], dryRun), 'utf8');
    console.log(JSON.stringify({ pending, ran: [], anyChanged: false }));
    return 0;
  }

  const version = await arachneVersion();
  const ran: RanItem[] = [];
  for (const item of pending) {
    console.error(`running ${item.tool} ${item.version}...`);
    const result = await runCompatCheck({
      toolId: item.tool,
      version: item.version,
      channel: item.channel,
      arachneVersion: version,
    });
    const previous = await previousResult(item.tool, item.version);
    const change = compareResults(result, previous);
    const path = await writeCompatResult(result);
    ran.push({
      tool: item.tool,
      version: item.version,
      channel: item.channel,
      path,
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

  const anyChanged = ran.some((r) => r.changed);
  await writeFile(titleOut, buildTitle(ran, anyChanged), 'utf8');
  await writeFile(bodyOut, renderBody(pending, ran, false), 'utf8');

  console.log(JSON.stringify({ pending, ran, anyChanged }));
  return 0;
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

function renderBody(pending: PendingItem[], ran: RanItem[], dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) lines.push('Dry run. No result file was written and no version was installed.', '');

  if (pending.length === 0) {
    lines.push('No new version was found on any tracked channel for any registered tool.');
    return lines.join('\n');
  }

  if (dryRun) {
    lines.push('Versions that would be tested:', '');
    for (const item of pending) lines.push(`- ${item.tool} ${item.version} (${item.channel})`);
    return lines.join('\n');
  }

  lines.push(summaryLine(ran), '');

  for (const r of ran) {
    lines.push(`### ${r.tool} ${r.version} (${r.channel})`, '');
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
