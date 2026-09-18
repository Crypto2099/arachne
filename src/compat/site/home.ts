import type { AggregateTool } from '../aggregate.js';
import type { VectorStatus } from '../classify.js';
import type { CompatResult } from '../result-schema.js';
import { CONSTRUCTION_PATHS, type ConstructionPath } from '../types.js';
import { escapeAttr, escapeHtml } from '../html.js';
import type { SiteData } from './data.js';
import { describeScript, renderScriptId } from './describe.js';
import { OUTCOME_EDGE, resultCell, resultLink, timestamp, toolLink } from './render.js';
import { renderPage, REPO_BLOB } from './shell.js';
import { latestResult, pathState } from './summaries.js';
import { formatCount, joinNames, PATH_TITLE, plural } from './vocabulary.js';

/**
 * The home page: the question the site answers, what the latest release of
 * every library got wrong, and one table with every library's answer to each
 * of the three questions. Everything on it is derived from the latest result
 * per library and question, so it is the page that changes when a release
 * fixes or breaks something.
 */
export function renderHomePage(data: SiteData): string {
  const root = '';
  const tools = data.aggregate.tools;
  const measuredTools = tools.filter((t) => (data.results.get(t.id) ?? []).length > 0);
  const chainTools = tools.filter((t) => t.paths.includes('decode-onchain')).length;
  const tested = data.aggregate.latestTestedAt;

  const body = `<h1>Which Cardano libraries get native script hashes right?</h1>
<p class="lede">Arachne runs real releases of ${formatCount(tools.length)} Cardano libraries against
${formatCount(data.corpus.vectorCount)} generated native scripts and against the
${formatCount(data.observed.scriptCount)} scripts a Cardano node has actually carried, and records
what each release did. A script's hash is taken over its CBOR bytes, and a list of 24 or more
items has two valid encodings, so two libraries can each be self-consistent and still disagree
about a script's hash, its address and its governance identifier.</p>
<p class="lede">Each library is asked up to three questions: what bytes it produces when
<a href="${root}methods.html#building">building a script</a>, whether it keeps the bytes it is
handed when <a href="${root}methods.html#round-tripping">round-tripping</a>, and whether it returns
the hash the chain has when <a href="${root}methods.html#chain-scripts">reading a script a node
accepted</a>. Every finding links to the release, the script and the verbatim text behind it.</p>

<h2 id="findings">What the latest releases get wrong</h2>
${renderFindings(data, root)}

<h2 id="libraries">Every library, latest release</h2>
<p class="prose">Rows are grouped by the language a library is used from. Each cell is the
library's latest release on that question; the release number is under the count, and the cell
links to the full result. Older releases and every problem found are on each library's own
page.</p>
${renderMatrix(data, root)}
<p class="note">${measuredTools.length} of ${tools.length} libraries have at least one result;
${chainTools} are asked the chain-script question. Last test run
${tested ? timestamp(tested) : 'never'}. The corpus is
<a href="${REPO_BLOB}/vectors/index.json">${formatCount(data.corpus.vectorCount)} vectors</a>
and the observed set is
<a href="${root}scripts.json">${formatCount(data.observed.scriptCount)} scripts</a>; a result made
against an earlier corpus says so on its own page.</p>`;

  return renderPage({
    title: 'Native script compatibility',
    root,
    current: 'libraries',
    body,
  });
}

interface ToolFinding {
  tool: AggregateTool;
  result: CompatResult;
  count: number;
  ids: string[];
}

const FINDING_LEAD: Record<ConstructionPath, Record<Exclude<VectorStatus, 'agreed'>, string>> = {
  'decode-onchain': {
    diverged: 'Wrong hash for a script a node has carried',
    refused: 'Scripts a node has carried that a library cannot read',
    unsupported: 'Scripts a node has carried that a library cannot represent',
  },
  construct: {
    diverged: 'Wrong hash when building a script',
    refused: 'Scripts refused when building',
    unsupported: 'Scripts a library cannot build at all',
  },
  decode: {
    diverged: 'Wrong hash when round-tripping bytes',
    refused: 'Bytes refused when round-tripping',
    unsupported: 'Bytes a library cannot represent',
  },
};

const SEVERITY: readonly Exclude<VectorStatus, 'agreed'>[] = ['diverged', 'refused', 'unsupported'];

/**
 * One card per question and outcome that any library's latest release hit,
 * worst first: a wrong hash for a script that is live on a chain is the
 * finding a reader most needs, and a construct an API cannot express is the
 * least surprising. Each card names every library affected with its count,
 * and where the affected libraries share the same scripts, names those too.
 */
function renderFindings(data: SiteData, root: string): string {
  const cards: string[] = [];
  const pathOrder: ConstructionPath[] = ['decode-onchain', 'construct', 'decode'];

  for (const status of SEVERITY) {
    for (const path of pathOrder) {
      const findings = collectFindings(data, path, status);
      if (findings.length === 0) continue;
      cards.push(renderFindingCard(data, path, status, findings, root));
    }
  }

  const framing = renderFramingSplit(data, root);
  if (framing) cards.push(framing);

  if (cards.length === 0) {
    return '<p class="prose">No latest release of any library got anything wrong on any question it was asked.</p>';
  }
  return `<ul class="findings">\n${cards.join('\n')}\n</ul>`;
}

function collectFindings(
  data: SiteData,
  path: ConstructionPath,
  status: Exclude<VectorStatus, 'agreed'>,
): ToolFinding[] {
  const findings: ToolFinding[] = [];
  for (const tool of data.aggregate.tools) {
    const result = latestResult(data.results.get(tool.id) ?? [], path);
    if (!result || result.status !== 'tested') continue;
    const ids = [...new Set(result.vectors.filter((v) => v.status === status).map((v) => v.id))];
    if (ids.length === 0) continue;
    findings.push({ tool, result, count: result.summary[status], ids });
  }
  return findings.sort(
    (a, b) => b.count - a.count || a.tool.displayName.localeCompare(b.tool.displayName),
  );
}

function renderFindingCard(
  data: SiteData,
  path: ConstructionPath,
  status: Exclude<VectorStatus, 'agreed'>,
  findings: ToolFinding[],
  root: string,
): string {
  const perTool = findings.map((f, i) => {
    const label = `${f.tool.displayName} ${f.result.version}`;
    const of = `${formatCount(f.count)} of ${formatCount(f.result.summary.total)}${i === 0 ? ' scripts' : ''}`;
    return `${resultLink(f.result, root, label)} (${of})`;
  });

  const shared = findings
    .map((f) => new Set(f.ids))
    .reduce((acc, ids) => new Set([...acc].filter((id) => ids.has(id))));
  const distinct = new Set(findings.flatMap((f) => f.ids));
  const verb = STATUS_VERB[status];

  // Who is affected by one script: every library on the card, or the named few.
  const whoFor = (id: string): string => {
    const affected = findings.filter((f) => f.ids.includes(id));
    return affected.length === findings.length
      ? 'every one of them'
      : joinNames(affected.map((f) => escapeHtml(f.tool.displayName)));
  };

  let scripts: string;
  if (findings.length === 1 && distinct.size <= 3) {
    const named = [...distinct].map((id) => nameScript(data, path, id)).join('; ');
    scripts = `${plural(distinct.size, 'The script involved is', 'The scripts involved are')} ${named}.`;
  } else if (distinct.size <= 3) {
    // Few enough to name each one and say which libraries it affects.
    const named = [...distinct].map((id) => `${nameScript(data, path, id)}, ${verb} ${whoFor(id)}`);
    scripts = `The ${plural(distinct.size, 'script', 'scripts')}: ${named.join('; ')}.`;
  } else if (shared.size > 0) {
    const named = [...shared].map((id) => nameScript(data, path, id)).join('; ');
    const rest = [...distinct].filter((id) => !shared.has(id));
    const restNamed =
      rest.length > 0 && rest.length <= 3
        ? ` The ${plural(rest.length, 'other', 'others')}: ${rest.map((id) => `${nameScript(data, path, id)}, ${verb} ${whoFor(id)}`).join('; ')}.`
        : rest.length > 0
          ? ` The other ${formatCount(rest.length)} are from the ${familiesPhrase(path, new Set(rest))}.`
          : '';
    scripts = `${formatCount(distinct.size)} distinct scripts in all. ${capitalize(plural(shared.size, 'One is', `${formatCount(shared.size)} are`))} ${verb} every library listed: ${named}.${restNamed}`;
  } else {
    scripts = `${formatCount(distinct.size)} distinct scripts in all, from the ${familiesPhrase(path, distinct)}.`;
  }

  const why = explainWhy(path, status, findings);

  return `<li class="finding ${OUTCOME_EDGE[status]}">
<p><strong>${escapeHtml(FINDING_LEAD[path][status])}.</strong> ${joinNames(perTool)}.</p>
<p>${scripts}${why ? ` ${why}` : ''}</p>
</li>`;
}

const STATUS_VERB: Record<Exclude<VectorStatus, 'agreed'>, string> = {
  diverged: 'wrong from',
  refused: 'refused by',
  unsupported: 'unrepresentable in',
};

function nameScript(data: SiteData, path: ConstructionPath, id: string): string {
  const description = describeScript(data, path, id);
  return `${renderScriptId(description, path)} (${escapeHtml(description.summary)})`;
}

function familiesPhrase(path: ConstructionPath, ids: Set<string>): string {
  if (path === 'decode-onchain') return 'observed set';
  const families = [...new Set([...ids].map((id) => id.split('/')[0] ?? id))].sort();
  return `${joinNames(families.map((f) => `<span class="mono">${escapeHtml(f)}</span>`))} ${plural(families.length, 'family', 'families')}`;
}

/** The mechanism behind a wrong hash, when every wrong hash across the affected libraries has the same one. */
function explainWhy(path: ConstructionPath, status: VectorStatus, findings: ToolFinding[]): string {
  if (status !== 'diverged') return '';
  const framings = new Set(
    findings.flatMap((f) =>
      f.result.vectors
        .filter((v) => v.status === 'diverged')
        .map((v) => v.matchedFraming ?? 'neither'),
    ),
  );
  if (framings.size !== 1) return '';
  const [only] = framings;
  if (path === 'construct') {
    return only === 'neither'
      ? 'The hash matches neither valid encoding of the script, so the library built a different script from the one it was given.'
      : '';
  }
  switch (only) {
    case 'definite':
      return 'Each wrong hash is the hash of the same script re-encoded with definite-length lists everywhere. The chain holds those scripts with an indefinite-length list, so an address derived from the returned hash holds nothing.';
    case 'cardanoBinary':
      return 'Each wrong hash is the hash of the same script re-encoded with the Haskell rule. The chain holds those scripts with a definite-length list, so an address derived from the returned hash holds nothing.';
    case 'neither':
      return 'The returned hash matches neither encoding of the script.';
    default:
      return '';
  }
}

/**
 * Which framing each library writes when it builds a script, as one card,
 * because the split itself is a finding: a script with a list of 24 or more
 * items built by a library on one side hashes differently from the same
 * script built by a library on the other.
 */
function renderFramingSplit(data: SiteData, root: string): string {
  const definite: AggregateTool[] = [];
  const haskellRule: AggregateTool[] = [];
  for (const tool of data.aggregate.tools) {
    const result = latestResult(data.results.get(tool.id) ?? [], 'construct');
    if (!result || result.status !== 'tested') continue;
    if (result.framing === 'definite') definite.push(tool);
    if (result.framing === 'cardanoBinary') haskellRule.push(tool);
  }
  if (definite.length === 0 || haskellRule.length === 0) return '';
  const names = (list: AggregateTool[]): string => joinNames(list.map((t) => toolLink(t, root)));
  return `<li class="finding edge-blue">
<p><strong>Two framings are in use, and they hash differently.</strong> When building a script, ${names(haskellRule)} ${plural(haskellRule.length, 'writes', 'write')} an indefinite-length list from 24 items, the rule the Haskell implementations follow. The other ${formatCount(definite.length)} write definite-length lists at every size: ${names(definite)}.</p>
<p>A script with a list of 24 or more items built by a library in one group has a different hash, and so a different address, from the same script built by a library in the other. Neither is wrong; a node accepts both. <a href="${root}methods.html#framings">How the two framings differ</a>.</p>
</li>`;
}

function renderMatrix(data: SiteData, root: string): string {
  const groups = new Map<string, AggregateTool[]>();
  for (const tool of data.aggregate.tools) {
    const key = tool.usedFrom ?? 'Unstated';
    const list = groups.get(key) ?? [];
    list.push(tool);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'en-US'));

  const head = `<tr>
<th scope="col">Library</th>
<th scope="col">Written in</th>
${CONSTRUCTION_PATHS.map((p) => `<th scope="col">${escapeHtml(PATH_TITLE[p])}</th>`).join('\n')}
</tr>`;

  const rows: string[] = [];
  for (const key of keys) {
    rows.push(
      `<tr class="group"><th scope="colgroup" colspan="5">Used from ${escapeHtml(key)}</th></tr>`,
    );
    const list = groups
      .get(key)!
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en-US'));
    for (const tool of list) {
      const results = data.results.get(tool.id) ?? [];
      const cells = CONSTRUCTION_PATHS.map(
        (path) =>
          `<td data-label="${escapeAttr(PATH_TITLE[path])}">${resultCell(pathState(tool, results, path), path, root)}</td>`,
      ).join('\n');
      rows.push(`<tr>
<td class="tool-name">${toolLink(tool, root)}</td>
<td data-label="Written in">${escapeHtml(tool.language ?? 'Unstated')}</td>
${cells}
</tr>`);
    }
  }

  return `<div class="table-wrap">
<table class="grid">
<thead>
${head}
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
