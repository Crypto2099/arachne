import type { AggregateResultSummary, AggregateTool, CompatAggregate } from './aggregate.js';
import type { CompatVersionDocument } from './version.js';
import type { Framing } from './classify.js';
import type { ConstructionPath, EngineDefinition } from './types.js';

/**
 * Renders the compat matrix as one self-contained HTML document: everything
 * the "for humans" half of the site needs, built once at deploy time from
 * the committed aggregate rather than fetched by the browser. There is no
 * `<script>` anywhere in the output: every value below is baked into the
 * markup at render time, which is what "must not fetch anything client-side"
 * means in practice, not merely "no XHR call written down anywhere". The
 * same rule covers fonts and stylesheets: the type is a system stack and the
 * stylesheet is inline, so the page renders identically with the network
 * switched off after the first load.
 *
 * The reader this page is written for has not read this repository and does
 * not know what "cardanoBinary" or "framing-preserving" mean; the lede states
 * the consequence in plain language before any table, and the legend defines
 * every value the tables go on to show, in place rather than linked away.
 */
export function renderSite(aggregate: CompatAggregate, version: CompatVersionDocument): string {
  const toolsByEngineId = new Map<string, AggregateTool[]>();
  for (const engine of aggregate.engines) toolsByEngineId.set(engine.id, []);
  for (const tool of aggregate.tools) {
    const bucket = toolsByEngineId.get(tool.engine.id);
    if (bucket) bucket.push(tool);
    else toolsByEngineId.set(tool.engine.id, [tool]);
  }

  const engineSections = aggregate.engines
    .map((engine) => renderEngineSection(engine, toolsByEngineId.get(engine.id) ?? [], aggregate))
    .join('\n');

  // How many encoders the tracked tools actually sit on, not how many tool
  // packages there are: two tools on one engine are one data point about
  // that engine, not two. Computed from the tools themselves, not from
  // aggregate.engines.length, so an engine with no tool registered against
  // it yet (there is none today) would not inflate the count.
  const engineCount = new Set(aggregate.tools.map((t) => t.engine.id)).size;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arachne compat matrix</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
<div class="masthead"></div>
<main>
<header class="page-head">
<div class="page-head-lede">
<h1>Arachne compat matrix</h1>
<p class="lede lede-lead">
A native script with 24 or more sub-scripts in one container has two different CBOR
encodings that are both valid, and therefore two different script hashes, two different
addresses and two different governance identifiers, for what is logically the same
script. Which of the two a tool produces depends only on which encoder built it. Derive
an address with one tool and sign a transaction spending it with another, and the script
hash each one used can differ: the ledger then refuses an otherwise correct transaction,
because it sees two unrelated scripts where you see one.
</p>
<p class="lede">
This page tracks, for each real tool people actually install, which of the two
encodings its current release produces, so a mismatch like that can be caught
before it reaches a real transaction. See
<a href="https://github.com/crypto2099/arachne/blob/main/spec/07-encoding-divergence.md">spec/07-encoding-divergence.md</a>
for how the divergence was confirmed on chain, and
<a href="https://github.com/crypto2099/arachne/blob/main/compat/README.md">compat/README.md</a>
for the full data model behind this page.
</p>
</div>
<div class="page-head-meta">
<dl class="meta">
<div><dt>Last tested</dt><dd>${renderTimestamp(aggregate.latestTestedAt)}</dd></div>
<div><dt>Tools tracked</dt><dd class="meta-number">${escapeHtml(String(version.toolCount))}</dd></div>
<div><dt>Independent engines</dt><dd class="meta-number">${escapeHtml(String(engineCount))}</dd></div>
<div><dt>Results recorded</dt><dd class="meta-number">${escapeHtml(String(version.resultCount))}</dd></div>
<div><dt>Aggregate digest (sha256)</dt><dd><code class="hash">${escapeHtml(version.aggregateDigest)}</code></dd></div>
</dl>
<p class="meta-links">
Machine-readable: <a href="aggregate.json">aggregate.json</a> carries this whole matrix,
<a href="version.json">version.json</a> is small enough to poll on a schedule to decide whether to
refetch it.
</p>
</div>
</header>
<p class="lede">
${escapeHtml(String(version.toolCount))} tools are tracked here, sitting on
${escapeHtml(String(engineCount))} independent engines. Two tools that sit on the same
engine, where neither reimplements the framing rule on its own, only count as one
observation about that engine, not two. See "Engine relation" in the legend below for
what each relation means; a tool's own section further down carries a warning only
when that actually applies to it.
</p>
${renderSplit(aggregate)}
${LEGEND}
${engineSections}
</main>
</body>
</html>
`;
}

/** Every path this project currently knows how to ask a tool about. */
const ALL_PATHS: ConstructionPath[] = ['construct', 'decode'];

/**
 * The order the five framing values are shown in wherever the page shows all
 * of them at once. Matches the legend's own order: the two encodings the
 * whole page is about first, then the three values that describe a run which
 * did not settle on either. Not sorted by how many tools landed there, so a
 * new result never reshuffles the page under a returning reader.
 */
const FRAMING_ORDER: Framing[] = [
  'definite',
  'cardanoBinary',
  'framing-preserving',
  'mixed',
  'undetermined',
];

/**
 * The one reference each side of the divide has that is never itself one of
 * the tools tracked here (`cardano-node` for `cardanoBinary`, the wider
 * JavaScript ecosystem for `definite`, both from
 * spec/07-encoding-divergence.md, "Which one is right"). Named once and used
 * both in a tool's own verdict and in the overview near the top of the page,
 * so the two cannot drift apart into two descriptions of one thing.
 */
const SIDE_PHRASE: Record<'definite' | 'cardanoBinary', string> = {
  definite: 'the framing most wallets and the wider JavaScript ecosystem emit',
  cardanoBinary: 'the framing cardano-node itself emits',
};

interface SplitEntry {
  displayName: string;
  paths: Set<ConstructionPath>;
}

/**
 * The overview a reader arrives for: which tracked tool produced which
 * encoding, grouped by encoding, above the per-tool detail rather than
 * reconstructed from it by scrolling. Every name here is a link into that
 * tool's own section, so the overview doubles as the page's contents at a
 * size where scrolling past eleven engines to find one tool would not work.
 *
 * A tool appears once per framing it produced, not once overall, and carries
 * the paths that produced it. That is the honest rendering for a tool like
 * gouroboros, which constructs `definite` but preserves whatever framing it
 * is handed on `decode`: collapsing it to one group would have to discard
 * one of the two readings to do it.
 */
function renderSplit(aggregate: CompatAggregate): string {
  const groups = new Map<Framing, Map<string, SplitEntry>>();
  for (const tool of aggregate.tools) {
    for (const result of tool.results) {
      if (result.framing === null) continue;
      let byTool = groups.get(result.framing);
      if (!byTool) {
        byTool = new Map();
        groups.set(result.framing, byTool);
      }
      let entry = byTool.get(tool.id);
      if (!entry) {
        entry = { displayName: tool.displayName, paths: new Set() };
        byTool.set(tool.id, entry);
      }
      entry.paths.add(result.path);
    }
  }

  const column = (framing: Framing): string =>
    renderSplitColumn(framing, groups.get(framing) as Map<string, SplitEntry>);
  // The two encodings the page is about are the split itself and share the
  // width equally, because neither is canonical. The three values that
  // describe a run which settled on neither are a row of smaller cards
  // below: real findings, and not a third and fourth side of a two-sided
  // divide.
  const sides = FRAMING_ORDER.slice(0, 2)
    .filter((f) => groups.has(f))
    .map(column);
  const rest = FRAMING_ORDER.slice(2)
    .filter((f) => groups.has(f))
    .map(column);
  if (sides.length === 0 && rest.length === 0) return '';
  const sideGrid = sides.length ? `<div class="split">\n${sides.join('\n')}\n</div>` : '';
  const restGrid = rest.length ? `<div class="split split-rest">\n${rest.join('\n')}\n</div>` : '';
  return `<div class="overview">\n${[sideGrid, restGrid].filter(Boolean).join('\n')}\n</div>`;
}

function renderSplitColumn(framing: Framing, tools: Map<string, SplitEntry>): string {
  const phrase =
    framing === 'definite' || framing === 'cardanoBinary'
      ? `<p class="side-note">${escapeHtml(SIDE_PHRASE[framing])}</p>`
      : '';
  const chips = [...tools.entries()]
    .map(([id, entry]) => {
      const paths = [...entry.paths].map((path) => escapeHtml(path)).join(', ');
      return `<a class="chip" href="#tool-${escapeAttr(id)}"><span class="chip-name">${escapeHtml(entry.displayName)}</span> <span class="chip-paths">${paths}</span></a>`;
    })
    .join('\n');
  return `<div class="side side-${escapeAttr(framing)} split-column">
<p class="side-head">${renderFramingBadge(framing)}</p>
${phrase}
<div class="chips">
${chips}
</div>
</div>`;
}

function renderEngineSection(
  engine: EngineDefinition,
  tools: AggregateTool[],
  aggregate: CompatAggregate,
): string {
  const homepage = engine.homepage
    ? ` &middot; <a href="${escapeHtml(engine.homepage)}">source</a>`
    : '';
  const note = engine.note ? `<p class="note engine-note">${escapeHtml(engine.note)}</p>` : '';
  const toolSections = tools.length
    ? tools.map((tool) => renderToolSection(tool, aggregate)).join('\n')
    : '<p class="note">No tool in the registry currently sits on this engine.</p>';

  return `<section class="engine" id="engine-${escapeAttr(engine.id)}">
<div class="engine-head">
<h2>${escapeHtml(engine.displayName)}</h2>
<p class="note">engine id <code>${escapeHtml(engine.id)}</code>${homepage}</p>
</div>
${note}
${toolSections}
</section>`;
}

function renderToolSection(tool: AggregateTool, aggregate: CompatAggregate): string {
  const homepage = tool.homepage
    ? ` &middot; <a href="${escapeHtml(tool.homepage)}">source</a>`
    : '';
  const warning = renderIndependenceWarning(tool, aggregate.tools);
  const pathsNote = renderPathsNote(tool);

  const rows = tool.results.length
    ? tool.results.map((r) => renderResultRow(r)).join('\n')
    : '<tr><td colspan="7" class="note">No result recorded yet.</td></tr>';

  return `<article class="tool" id="tool-${escapeAttr(tool.id)}">
<div class="tool-head">
<h3>${escapeHtml(tool.displayName)} <span class="relation">${escapeHtml(tool.engine.relation)}</span></h3>
<p class="note"><code>${escapeHtml(tool.id)}</code>${homepage}</p>
</div>
${renderVerdicts(tool, aggregate)}
${warning}
${pathsNote}
<div class="table-wrap">
<table class="matrix">
<colgroup>
<col class="c-version"><col class="c-channel"><col class="c-path"><col class="c-tested"><col class="c-corpus"><col class="c-framing"><col class="c-vectors">
</colgroup>
<thead>
<tr>
<th scope="col">Version</th>
<th scope="col">Channel</th>
<th scope="col">Path</th>
<th scope="col">Tested</th>
<th scope="col">Corpus</th>
<th scope="col">Framing</th>
<th scope="col">Vectors</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</article>`;
}

/**
 * Warns only when this tool shares an engine with another tracked tool and
 * the two do not corroborate each other (`isIndependentEvidence` in
 * `src/compat/registry.ts` said no), which is the one case where two rows on
 * this page look like separate evidence but are not. Every other tool gets
 * nothing here: the old per-tool "independent evidence alongside: ..." line
 * carried the same five names on every tool's section because every tracked
 * tool is currently independent of every other, which told a reader nothing
 * they could act on and had to be read five times to confirm.
 */
function renderIndependenceWarning(tool: AggregateTool, allTools: AggregateTool[]): string {
  const notCorroborating = allTools.filter(
    (other) => other.id !== tool.id && !tool.independentOf.includes(other.id),
  );
  if (notCorroborating.length === 0) return '';
  const names = notCorroborating.map((t) => escapeHtml(t.displayName)).join(', ');
  return `<p class="warning">Shares the <code>${escapeHtml(tool.engine.id)}</code> engine with ${names}, and neither reimplements the framing rule independently: agreement between them is one observation about that engine, not separate evidence for it.</p>`;
}

/**
 * States a gap explicitly rather than leaving it to be inferred from an
 * absent row. Two different gaps share this line: a path this tool is not
 * registered against at all (`unmeasured`, styled to stand out) reads
 * differently from a path it is registered against but has not produced a
 * result for yet (simply not run yet). Both currently show as zero rows for
 * that path in the table below; this is what tells them apart. Reads
 * straight from `tool.paths`, so once a tool's registry entry adds a path
 * (as is planned for the four tools only registered against `construct`
 * today) this note updates on its own the next time the aggregate and this
 * page are rebuilt, without a second change here.
 */
function renderPathsNote(tool: AggregateTool): string {
  const measured = new Set(tool.results.map((r) => r.path));
  const gaps: string[] = [];
  for (const path of ALL_PATHS) {
    if (!tool.paths.includes(path)) {
      gaps.push(
        `<code>${escapeHtml(path)}</code> is <span class="unmeasured">unmeasured</span>: this tool is not registered against the ${escapeHtml(path)} path`,
      );
    } else if (!measured.has(path)) {
      gaps.push(`<code>${escapeHtml(path)}</code> is registered but has no recorded result yet`);
    }
  }
  if (gaps.length === 0) return '';
  return `<p class="note">${gaps.join('; ')}.</p>`;
}

/**
 * One verdict panel per distinct framing this tool has produced, at the top
 * of its section, where the old layout repeated the identical sentence
 * inside every row of the table below it. The sentence is a function of the
 * framing, the aggregate and the tool, and of nothing that varies from one
 * row to the next, so a tool whose every recorded version landed on the same
 * side states its finding once instead of once per version. A tool whose
 * versions or paths did not agree gets a panel each, which is the case worth
 * noticing and is now the only case where more than one panel appears.
 *
 * Order follows the tool's own results rather than `FRAMING_ORDER`, so the
 * panels sit in the same order as the rows that produced them.
 */
function renderVerdicts(tool: AggregateTool, aggregate: CompatAggregate): string {
  const seen: Framing[] = [];
  for (const result of tool.results) {
    if (result.framing !== null && !seen.includes(result.framing)) seen.push(result.framing);
  }
  if (seen.length === 0) return '';
  const panels = seen
    .map(
      (framing) => `<div class="side side-${escapeAttr(framing)} verdict">
<p class="verdict-head">${renderFramingBadge(framing)}</p>
<p class="verdict-text">${framingVerdict(framing, aggregate, tool.id)}</p>
</div>`,
    )
    .join('\n');
  return `<div class="verdicts">\n${panels}\n</div>`;
}

function renderResultRow(result: AggregateResultSummary): string {
  const head = `<td data-label="Version"><span class="version">${escapeHtml(result.version)}</span></td>
<td data-label="Channel"><span class="channel">${escapeHtml(result.channel)}</span></td>
<td data-label="Path">${escapeHtml(result.path)}</td>
<td data-label="Tested">${renderTimestamp(result.testedAt)}</td>
<td data-label="Corpus">${renderDigest(result.corpusDigest)}</td>`;

  if (result.status === 'untested') {
    return `<tr class="untested" data-channel="${escapeAttr(result.channel)}">
${head}
<td colspan="2" class="reason">untested${result.reason ? `: ${escapeHtml(result.reason)}` : ''}</td>
</tr>`;
  }

  return `<tr data-channel="${escapeAttr(result.channel)}">
${head}
<td data-label="Framing">${result.framing === null ? '<span class="framing framing-none">none</span>' : renderFramingBadge(result.framing)}</td>
<td data-label="Vectors" class="vectors">${renderVectorCounts(result.summary)}</td>
</tr>`;
}

function renderFramingBadge(framing: Framing): string {
  return `<span class="framing framing-${escapeAttr(framing)}">${escapeHtml(framing)}</span>`;
}

/**
 * The same counts the aggregate records, in the same words and the same
 * order, with each term wrapped so the stylesheet can push a zero back and
 * bring a non-zero `diverged` forward. Nothing here decides what to show:
 * across eighty rows the four counts are mostly zeros, and a zero that reads
 * as quietly as it counts is what makes the one row with a hash matching
 * neither valid encoding findable by eye.
 */
function renderVectorCounts(summary: AggregateResultSummary['summary']): string {
  const term = (count: number, word: string, extra = ''): string =>
    `<span class="count${count === 0 ? ' count-zero' : ''}${extra}">${escapeHtml(String(count))} ${escapeHtml(word)}</span>`;
  const terms = [
    term(summary.agreed, 'agreed'),
    ', ',
    term(summary.diverged, 'diverged', summary.diverged > 0 ? ' count-diverged' : ''),
    ', ',
    term(summary.refused, 'refused'),
    ', ',
    term(summary.unsupported, 'unsupported'),
    ` of <span class="count count-total">${escapeHtml(String(summary.total))}</span>`,
  ].join('');
  return `<span class="counts">${terms}</span>`;
}

/**
 * The raw framing value stays on the page unchanged (`aggregate.json`'s own
 * field, badge and all), and this is what sits next to it: one sentence a
 * reader who has never opened this repository can act on. `definite` and
 * `cardanoBinary` are anchored to `SIDE_PHRASE` above, so the sentence reads
 * the same way on a tool's own row as it does on any other row rather than
 * naming the row's own tool back at it. Which other tracked tool currently
 * lands on the same side is named separately, computed from this page's own
 * data, so that part of the claim is checkable against the rest of the page
 * rather than asserted.
 */
function framingVerdict(framing: Framing, aggregate: CompatAggregate, toolId: string): string {
  switch (framing) {
    case 'definite':
      return sideVerdict('definite', aggregate, toolId);
    case 'cardanoBinary':
      return sideVerdict('cardanoBinary', aggregate, toolId);
    case 'framing-preserving':
      return 'Returned the hash of whichever bytes it was handed, matching either encoding depending on the input, rather than settling on one.';
    case 'mixed':
      return "This run's answers matched both encodings, on different scripts: not settled on one rule.";
    case 'undetermined':
      return 'Nothing in this run answered decisively for a script where the two encodings actually differ, so this result does not say which one the tool follows.';
  }
}

function sideVerdict(
  framing: 'definite' | 'cardanoBinary',
  aggregate: CompatAggregate,
  toolId: string,
): string {
  const base = `Produces the ${framing} encoding: ${SIDE_PHRASE[framing]}.`;
  const others = agreeingTools(aggregate, framing, toolId);
  if (others.length === 0) return base;
  return `${base} On this page, also produced by ${others.join(', ')}.`;
}

/** Other tracked tools with at least one recorded result on the same side of the divide. */
function agreeingTools(
  aggregate: CompatAggregate,
  framing: 'definite' | 'cardanoBinary',
  excludeToolId: string,
): string[] {
  const names = new Set<string>();
  for (const other of aggregate.tools) {
    if (other.id === excludeToolId) continue;
    if (other.results.some((r) => r.framing === framing)) names.add(other.displayName);
  }
  return [...names].map((name) => escapeHtml(name));
}

/**
 * Renders a corpus digest as a truncated, monospace badge carrying a square
 * swatch whose hue is derived deterministically from the full digest string.
 * Two results that share a `corpusDigest` render the same text and the same
 * swatch; two that do not are visually distinct even when their truncated
 * prefixes are hard to compare by eye in a dense table. Saturation and
 * lightness are fixed rather than derived, so no digest ever renders a
 * swatch that reads as louder than another one, and the badge text itself
 * stays at the table's own color in both schemes. This is a rendering aid
 * only: the full digest is always in the `title` attribute, and the
 * comparison a reader should actually trust is the text, not the swatch.
 */
function renderDigest(digest: string): string {
  const short = digest.slice(0, 12);
  const hue = hashToHue(digest);
  return `<span class="corpus" title="${escapeAttr(digest)}"><span class="corpus-mark" style="background: hsl(${hue} 62% 46%)"></span>${escapeHtml(short)}</span>`;
}

/** FNV-1a over the digest string, folded into a hue. Deterministic, not cryptographic: it only has to be stable and roughly well-distributed across the ~16 corpus digests this project has ever produced. */
function hashToHue(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}

function renderTimestamp(value: string | null): string {
  if (value === null) return '<span class="note">never</span>';
  return `<time datetime="${escapeAttr(value)}">${escapeHtml(value)}</time>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/**
 * Two rules of equal weight, one unbroken and one segmented, which is the
 * whole subject of this page drawn rather than described: an encoder that
 * frames every array the same way, and one that changes at 24. Inlined as a
 * data URI, so the tab icon costs no request and the "fetches nothing
 * off-origin" rule holds for the favicon too. `currentColor` is not
 * available to a favicon, so both rules are drawn in a mid grey that holds
 * up against a light and a dark tab strip.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" rx="3" fill="#222733"/>' +
      '<rect x="4" y="2" width="2.4" height="12" rx="1.2" fill="#d9a94a"/>' +
      '<rect x="9.6" y="2" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '<rect x="9.6" y="6.4" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '<rect x="9.6" y="10.8" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '</svg>',
  );

// Defines every term the tables below use, in place rather than linked away,
// because that is where a reader hits the word for the first time. The five
// framing entries carry the same `side` marker the overview and every tool's
// verdict panel use, so the mark a reader meets in the definition is the
// mark they then see against a result. Static markup: nothing here depends
// on the aggregate, so it is a module-level constant rather than something
// rebuilt per render.
const LEGEND = `<section class="legend">
<h2>Terms used on this page</h2>
<p>
<code>definite</code> and <code>cardanoBinary</code> name the two encodings this whole
page is about. Below, a tool's "framing" reuses those same two names for whichever
encoding its answers matched, run over the vectors where the two actually differ (24 or
more sub-scripts in one container; below that they are byte-identical and say nothing
about which rule a tool follows). The other three framing values,
<code>framing-preserving</code>, <code>mixed</code> and <code>undetermined</code>,
describe a run whose answers did not settle on one of the two.
</p>
<dl class="legend-framings">
<div class="side side-definite">
<dt><code>definite</code></dt>
<dd>A definite-length CBOR array header at every size, including a container of 24 or
more children. What cardano-serialization-lib, MeshJS and most JavaScript tooling
produce.</dd>
</div>
<div class="side side-cardanoBinary">
<dt><code>cardanoBinary</code></dt>
<dd>A definite-length array header up to 23 children, switching to an
indefinite-length header with a closing break byte from 24 up. What cardano-node and
cardano-cli produce.</dd>
</div>
<div class="side side-framing-preserving">
<dt><code>framing-preserving</code></dt>
<dd>Only reachable on the <code>decode</code> path: the tool returned the hash of the
exact bytes it was handed, whichever of the two encodings that happened to be, instead
of re-encoding first. It has no fixed side of its own; it reflects whatever it was
given.</dd>
</div>
<div class="side side-mixed">
<dt><code>mixed</code></dt>
<dd>In one run, the tool's answers matched both encodings on different scripts: not
settled on one rule. Never folded into <code>definite</code> or <code>cardanoBinary</code>,
because that would hide the disagreement this value exists to report.</dd>
</div>
<div class="side side-undetermined">
<dt><code>undetermined</code></dt>
<dd>Nothing in this run answered decisively for a script where the two encodings
actually differ, so this run does not yet say which encoding the tool follows.</dd>
</div>
</dl>
<p>Other words this page uses:</p>
<dl class="legend-terms">
<div>
<dt>Path: <code>construct</code></dt>
<dd>The tool built a script from its JSON shape, or its own builder API, and the
result was hashed. Measures what the tool does when it authors a script from
scratch.</dd>
</div>
<div>
<dt>Path: <code>decode</code></dt>
<dd>The tool was handed an already-encoded script's exact CBOR bytes, once for each of
its two recorded encodings, and asked to hash what it received. Measures whether the
tool reproduces the encoding it was given, or normalizes every input toward one
encoding regardless.</dd>
</div>
<div>
<dt>Path: <span class="unmeasured">unmeasured</span></dt>
<dd>This tool is not currently registered to run against this path at all, so nothing
has been measured there. Different from a version that was tested and failed to
install, which is recorded as "untested" together with the reason.</dd>
</div>
<div>
<dt>Vectors: <code>agreed</code>, <code>diverged</code>, <code>refused</code>,
<code>unsupported</code></dt>
<dd>What happened for each script in the corpus, within one run. <code>agreed</code>:
the hash matched one of the script's two valid recorded hashes. <code>diverged</code>:
the tool produced a hash and it matched neither, a third value for a script that
should have at most two. <code>refused</code>: the tool ran and declined to answer,
with its own error text kept. <code>unsupported</code>: the tool's own API cannot
represent this construct at all, so it was never attempted.</dd>
</div>
<div>
<dt>Corpus</dt>
<dd>A short, colored badge for the digest of the exact corpus (<code>vectors/index.json</code>)
that run was tested against; the full digest is in the badge's title on hover. Two
results are only directly comparable when this matches, and the color is a visual aid
for spotting that at a glance, not a judgment about either result.</dd>
</div>
<div>
<dt>Engine relation: <code>depends</code>, <code>fork</code>, <code>vendored</code>,
<code>reimplements</code>, <code>own</code></dt>
<dd>How a tool relates to the encoder that actually produces its bytes, shown next to
each tool's name. <code>depends</code>: an ordinary dependency, so an upstream fix
arrives once the tool updates it. <code>fork</code>: ships its own forked build under a
different name, which may never receive an upstream fix. <code>vendored</code>:
carries a private copy with no dependency link at all, same risk as a fork and less
visible. <code>reimplements</code>: an independent rewrite of the same rule, sharing no
code with the engine, so agreement between the two is real corroboration rather than
one dependency counted twice. <code>own</code>: its own encoder, with no shared
ancestry to anything else tracked here.</dd>
</div>
</dl>
</section>`;

// Inline and same-origin only, per the deploy contract: no external
// stylesheet or font is fetched, so both families below are system stacks.
// `color-scheme` plus the `prefers-color-scheme` override are what keep this
// correct in both light and dark without any script deciding at runtime.
//
// Two families carry one rule: a value a machine produced is set in the
// monospace face, and everything a person wrote is set in the serif. That is
// why versions, timestamps, digests, identifiers and framing values are
// monospace while the column headings above them are not; the heading is a
// label, the cell is a reading.
//
// The five `side-*` rules are the page's one visual system. Each draws a
// 4px marker whose pattern restates what the framing value means: an
// unbroken rule for `definite`, which frames every array the same way; a
// segmented one for `cardanoBinary`, which changes at 24; alternating bands
// for `framing-preserving`, which returns whichever it was handed; a
// cross-hatch for `mixed`, which matched both; and a faint dotted rule for
// `undetermined`, which answered for neither. The pattern is redundant with
// the badge text next to it in every place it appears, so nothing is
// carried by color alone.
const STYLE = `
:root {
  color-scheme: light dark;
  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ground: #e9ebf0;
  --card: #ffffff;
  --ink: #191d26;
  --ink-2: #5c6472;
  --rule: #d3d8e1;
  --rule-soft: #e6e9ef;
  --section-rule: #3b4354;
  --link: #1f4fb0;
  --node: #2a56b8;
  --node-ink: #1b3c85;
  --node-tint: #e8edfb;
  --node-line: #bacbf0;
  --node-wash: #f3f6fd;
  --eco: #9a6a00;
  --eco-ink: #7a5300;
  --eco-tint: #fbf1da;
  --eco-line: #e7d19b;
  --eco-wash: #fdf8ed;
  --alarm: #a3201f;
  --caution: #fdf3e3;
  --caution-line: #e6cfa4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #101319;
    --card: #181c24;
    --ink: #e4e8f0;
    --ink-2: #99a1b2;
    --rule: #2c3240;
    --rule-soft: #232833;
    --section-rule: #4b5466;
    --link: #8ab0ff;
    --node: #6f9cf5;
    --node-ink: #bacefb;
    --node-tint: #182742;
    --node-line: #2f4a7d;
    --node-wash: #151e33;
    --eco: #d9a94a;
    --eco-ink: #f0cd87;
    --eco-tint: #332811;
    --eco-line: #5e4a1c;
    --eco-wash: #251e11;
    --alarm: #ff938c;
    --caution: #2d2413;
    --caution-line: #574728;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 5rem;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 1.0625rem;
  line-height: 1.6;
  -webkit-text-size-adjust: 100%;
}

/* The page's thesis drawn once, full bleed: two encodings, equal width,
   neither one canonical. */
.masthead {
  height: 5px;
  background: linear-gradient(to right, var(--eco) 0 50%, var(--node) 50% 100%);
}

main { max-width: 74rem; margin: 0 auto; padding: 2.5rem 1.25rem 0; }

h1 {
  font-size: clamp(2rem, 1.4rem + 2.2vw, 2.75rem);
  line-height: 1.12;
  letter-spacing: -0.018em;
  font-weight: 600;
  margin: 0 0 1rem;
}
h2 {
  font-size: 1.5rem;
  line-height: 1.2;
  letter-spacing: -0.012em;
  font-weight: 600;
  margin: 0;
}
h3 {
  font-size: 1.1875rem;
  line-height: 1.25;
  font-weight: 600;
  margin: 0;
}
p { margin: 0 0 0.9rem; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 2px; }

code, time, .version, .channel, .corpus, .framing, .relation, .count, .reason, .hash {
  font-family: var(--mono);
  font-variant-ligatures: none;
}
code {
  font-size: 0.86em;
  background: var(--rule-soft);
  padding: 0.05em 0.32em;
  border-radius: 3px;
  overflow-wrap: anywhere;
}

.lede { max-width: 38rem; margin: 0 0 1rem; }
.lede-lead { font-size: 1.1875rem; line-height: 1.55; }
.note { color: var(--ink-2); font-size: 0.875rem; line-height: 1.5; margin: 0; }
.note code { background: transparent; padding: 0; }

/* Masthead block: the argument on the left at a readable measure, the
   provenance of the data beside it rather than under it, so the first
   screen carries both. */
.page-head { display: grid; gap: 2rem; margin: 0 0 1.5rem; }
@media (min-width: 62rem) {
  .page-head {
    grid-template-columns: minmax(0, 38rem) minmax(15rem, 1fr);
    gap: 3.5rem;
    align-items: start;
  }
}
.page-head-lede > :last-child { margin-bottom: 0; }
.page-head-meta { display: grid; gap: 1rem; align-content: start; }
.meta-links {
  margin: 0;
  color: var(--ink-2);
  font-size: 0.875rem;
  line-height: 1.5;
  padding-left: 1.25rem;
}
.meta {
  display: grid;
  gap: 0.85rem;
  margin: 0;
  padding: 1.15rem 1.25rem;
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 10px;
}
.meta div { margin: 0; }
.meta dt { font-size: 0.8125rem; color: var(--ink-2); line-height: 1.35; }
.meta dd { margin: 0.1rem 0 0; font-size: 0.9375rem; line-height: 1.4; }
.meta-number { font-family: var(--mono); font-size: 1.35rem; line-height: 1.15; }
.hash { font-size: 0.75rem; color: var(--ink-2); overflow-wrap: anywhere; line-height: 1.45; }

/* Every side marker on the page: a 4px rule whose pattern restates the
   framing it stands for. */
.side { position: relative; padding-left: 1rem; }
.side::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 2px;
  background: var(--side-mark, var(--rule));
}
.side-definite { --side-mark: var(--eco); --side-wash: var(--eco-wash); }
.side-cardanoBinary {
  --side-mark: repeating-linear-gradient(to bottom, var(--node) 0 9px, transparent 9px 15px);
  --side-wash: var(--node-wash);
}
.side-framing-preserving {
  --side-mark: repeating-linear-gradient(to bottom, var(--eco) 0 7px, var(--node) 7px 14px);
}
.side-mixed {
  --side-mark: repeating-linear-gradient(135deg, var(--eco) 0 3px, var(--node) 3px 6px);
}
.side-undetermined {
  --side-mark: repeating-linear-gradient(to bottom, var(--ink-2) 0 2px, transparent 2px 6px);
}

/* Which tool produced which encoding, before any table asks the reader to
   work it out. Auto-fit rather than a fixed pair of columns: three groups
   today, five if a run ever comes back mixed or undetermined. */
.overview { display: grid; gap: 0.75rem; margin: 0 0 2.5rem; }
.split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: 0.75rem;
}
/* auto-fill, not auto-fit: a single unsettled value stays one card wide
   instead of stretching across the page as if it were the whole finding. */
.split-rest {
  grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr));
  align-items: start;
}
.split-column {
  padding: 1.15rem 1.25rem 1.25rem 1.9rem;
  background: var(--side-wash, var(--card));
  border: 1px solid var(--rule);
  border-radius: 10px;
}
.split-column::before { left: 1.15rem; top: 1.15rem; bottom: 1.25rem; }
.side-head { margin: 0 0 0.5rem; }
.side-note {
  color: var(--ink-2);
  font-size: 0.875rem;
  line-height: 1.45;
  margin: 0 0 0.9rem;
  max-width: 22rem;
}
.chips { display: grid; gap: 0.4rem; align-content: start; }
.chip {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.15rem 0.85rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--rule);
  border-radius: 6px;
  background: var(--card);
  color: inherit;
  text-decoration: none;
}
.chip:hover { border-color: var(--ink-2); }
.chip-name { font-size: 0.9375rem; line-height: 1.35; }
.chip-paths {
  font-family: var(--mono);
  font-size: 0.6875rem;
  color: var(--ink-2);
  line-height: 1.5;
}

.legend {
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 1.5rem 1.5rem 0.75rem;
  margin: 0 0 3.5rem;
}
.legend h2 { font-size: 1.3125rem; margin: 0 0 0.9rem; }
.legend > p { color: var(--ink-2); max-width: 42rem; font-size: 0.9375rem; }
.legend dl { margin: 0 0 1.25rem; padding: 0; }
.legend dl div { break-inside: avoid; margin: 0 0 1rem; }
.legend dt { font-weight: 600; font-size: 0.9375rem; margin: 0 0 0.15rem; }
.legend dd { margin: 0; font-size: 0.9375rem; line-height: 1.5; color: var(--ink-2); }
.legend dd code, .legend dt code { font-size: 0.82em; }
.legend-framings div { padding-bottom: 0.15rem; }
@media (min-width: 52rem) {
  .legend-framings, .legend-terms { columns: 2; column-gap: 2.5rem; }
}

.engine { margin: 0 0 3.5rem; scroll-margin-top: 1rem; }
.engine-head {
  border-top: 2px solid var(--section-rule);
  padding-top: 0.85rem;
  margin: 0 0 1.5rem;
}
.engine-head .note { margin-top: 0.3rem; }
.engine-note { max-width: 42rem; margin: -1rem 0 1.5rem; }

.tool {
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 1.25rem 1.35rem;
  margin: 0 0 1.25rem;
  scroll-margin-top: 1rem;
}
.tool-head { margin: 0 0 1rem; }
.tool-head .note { margin-top: 0.25rem; }
.relation {
  font-size: 0.75rem;
  font-weight: normal;
  color: var(--ink-2);
  border: 1px solid var(--rule);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  vertical-align: 0.12em;
  white-space: nowrap;
}

/* The finding, stated once per distinct framing rather than once per row. */
.verdicts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr));
  gap: 0.75rem;
  margin: 0 0 1rem;
}
.verdict {
  padding: 0.75rem 0.9rem 0.8rem 1.35rem;
  background: var(--side-wash, var(--ground));
  border-radius: 8px;
}
.verdict::before { left: 0.6rem; top: 0.75rem; bottom: 0.8rem; }
.verdict-head { margin: 0 0 0.35rem; }
.verdict-text { margin: 0; font-size: 0.9375rem; line-height: 1.5; }

.framing {
  display: inline-block;
  font-size: 0.8125rem;
  line-height: 1.5;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--rule);
  background: var(--rule-soft);
  color: var(--ink);
  white-space: nowrap;
}
.framing-definite { background: var(--eco-tint); border-color: var(--eco-line); color: var(--eco-ink); }
.framing-cardanoBinary { background: var(--node-tint); border-color: var(--node-line); color: var(--node-ink); }
.framing-none { font-style: italic; color: var(--ink-2); }

.warning {
  background: var(--caution);
  border: 1px solid var(--caution-line);
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  font-size: 0.9375rem;
  line-height: 1.5;
  margin: 0 0 1rem;
  max-width: 46rem;
}
.warning code { background: transparent; padding: 0; }
.unmeasured { font-style: italic; }

.table-wrap { overflow-x: auto; margin: 1rem -0.35rem 0; padding: 0 0.35rem; }
/* One fixed set of column widths for every tool's table. Sized to content
   rather than guessed: an auto layout gives each card its own widths, so
   eleven cards step their columns across the page and a row cannot be
   compared with the row above it in the next card down. Below the width
   where these seven columns fit, the whole table becomes labeled blocks
   instead (further down), so a fixed layout never has to clip anything. */
.matrix {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  min-width: 60rem;
  font-size: 0.8125rem;
}
.matrix col.c-version { width: 7.5%; }
.matrix col.c-channel { width: 8%; }
.matrix col.c-path { width: 8.5%; }
.matrix col.c-tested { width: 19.5%; }
.matrix col.c-corpus { width: 12.5%; }
.matrix col.c-framing { width: 18%; }
.matrix col.c-vectors { width: 26%; }
.matrix th {
  font-family: var(--serif);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--ink-2);
  text-align: left;
  padding: 0 0.5rem 0.4rem;
  border-bottom: 1px solid var(--rule);
  white-space: nowrap;
}
.matrix td {
  font-family: var(--mono);
  padding: 0.5rem;
  border-bottom: 1px solid var(--rule-soft);
  vertical-align: baseline;
  white-space: nowrap;
}
.matrix th:first-child, .matrix td:first-child { padding-left: 0; }
.matrix th:last-child, .matrix td:last-child { padding-right: 0; }
.matrix tbody tr:last-child td { border-bottom: 0; }
.matrix td.vectors { white-space: normal; }
.matrix time { color: var(--ink-2); }
.version { font-weight: 600; }
.channel { color: var(--ink-2); }
.matrix tr[data-channel="previous"] .version { font-weight: normal; color: var(--ink-2); }
tr.untested { color: var(--ink-2); }
/* Qualified with the element, so this outweighs the nowrap that every other
   cell wants: an untested row carries a tool's own error text, which is
   arbitrary length and usually holds a URL with no break opportunity in it. */
.matrix td.reason {
  color: var(--ink-2);
  font-size: 0.78rem;
  white-space: normal;
  overflow-wrap: anywhere;
}

.corpus { white-space: nowrap; }
.corpus-mark {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 2px;
  margin-right: 0.4rem;
  vertical-align: -0.02em;
}

/* Four counts, mostly zeros. The zeros recede so a non-zero one is what the
   eye lands on, and a hash matching neither valid encoding is the one
   outcome on this page that is nobody's intended behavior. */
.count { white-space: nowrap; }
.count-zero { color: var(--ink-2); }
.count-total { color: var(--ink-2); }
.count-diverged { color: var(--alarm); font-weight: 700; }

@media (max-width: 68rem) {
  main { padding-top: 1.75rem; }
  /* The header has stacked, so this no longer aligns with the card above it. */
  .meta-links { padding-left: 0; }
  /* Seven columns do not fit a phone, and a table that scrolls sideways
     inside the page hides whichever column the reader has not reached. Each
     row becomes a labeled block instead, carrying the same seven fields in
     the same order. */
  .matrix thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .matrix { min-width: 0; table-layout: auto; }
  .matrix colgroup { display: none; }
  .matrix, .matrix tbody, .matrix tr, .matrix td { display: block; width: 100%; }
  .matrix tr {
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    margin: 0 0 0.6rem;
  }
  .matrix tbody tr:last-child { margin-bottom: 0; }
  .matrix td, .matrix tbody tr:last-child td {
    border: 0;
    padding: 0.12rem 0;
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    justify-items: start;
    gap: 0.7rem;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .matrix td::before {
    content: attr(data-label);
    font-family: var(--serif);
    color: var(--ink-2);
  }
  .matrix td.reason { display: block; padding-top: 0.3rem; }
  .table-wrap { overflow-x: visible; }
}
@media (max-width: 34rem) {
  main { padding-left: 1rem; padding-right: 1rem; }
  .tool, .legend, .split-column { padding-left: 1rem; padding-right: 1rem; }
  .split-column { padding-left: 1.6rem; }
  .split-column::before { left: 1rem; }
  .meta { padding-left: 1rem; padding-right: 1rem; }
}
`;
