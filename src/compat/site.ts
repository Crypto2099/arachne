import type { AggregateResultSummary, AggregateTool, CompatAggregate } from './aggregate.js';
import type { CompatVersionDocument } from './version.js';
import type { ConstructionPath, EngineDefinition } from './types.js';

/**
 * Renders the compat matrix as one self-contained HTML document: everything
 * the "for humans" half of the site needs, built once at deploy time from
 * the committed aggregate rather than fetched by the browser. There is no
 * `<script>` anywhere in the output: every value below is baked into the
 * markup at render time, which is what "must not fetch anything client-side"
 * means in practice, not merely "no XHR call written down anywhere".
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
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Arachne compat matrix</h1>
<p class="lede">
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
<dl class="meta">
<div><dt>Last tested</dt><dd>${renderTimestamp(aggregate.latestTestedAt)}</dd></div>
<div><dt>Tools tracked</dt><dd>${escapeHtml(String(version.toolCount))}</dd></div>
<div><dt>Independent engines</dt><dd>${escapeHtml(String(engineCount))}</dd></div>
<div><dt>Results recorded</dt><dd>${escapeHtml(String(version.resultCount))}</dd></div>
<div><dt>Aggregate digest (sha256)</dt><dd><code class="digest">${escapeHtml(version.aggregateDigest)}</code></dd></div>
</dl>
<p class="lede">
${escapeHtml(String(version.toolCount))} tools are tracked here, sitting on
${escapeHtml(String(engineCount))} independent engines. Two tools that sit on the same
engine, where neither reimplements the framing rule on its own, only count as one
observation about that engine, not two. See "Engine relation" in the legend below for
what each relation means; a tool's own section further down carries a warning only
when that actually applies to it.
</p>
<p class="lede">
Machine-readable: <a href="aggregate.json">aggregate.json</a> carries this whole matrix,
<a href="version.json">version.json</a> is small enough to poll on a schedule to decide whether to
refetch it.
</p>
${LEGEND}
</header>
${engineSections}
</main>
</body>
</html>
`;
}

/** Every path this project currently knows how to ask a tool about. */
const ALL_PATHS: ConstructionPath[] = ['construct', 'decode'];

function renderEngineSection(
  engine: EngineDefinition,
  tools: AggregateTool[],
  aggregate: CompatAggregate,
): string {
  const homepage = engine.homepage
    ? ` &middot; <a href="${escapeHtml(engine.homepage)}">source</a>`
    : '';
  const note = engine.note ? `<p class="note">${escapeHtml(engine.note)}</p>` : '';
  const toolSections = tools.length
    ? tools.map((tool) => renderToolSection(tool, aggregate)).join('\n')
    : '<p class="note">No tool in the registry currently sits on this engine.</p>';

  return `<section class="engine">
<h2 id="engine-${escapeAttr(engine.id)}">${escapeHtml(engine.displayName)}</h2>
<p class="note">engine id <code>${escapeHtml(engine.id)}</code>${homepage}</p>
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
    ? tool.results.map((r) => renderResultRow(r, aggregate, tool.id)).join('\n')
    : '<tr><td colspan="7" class="note">No result recorded yet.</td></tr>';

  return `<article class="tool">
<h3 id="tool-${escapeAttr(tool.id)}">${escapeHtml(tool.displayName)} <span class="relation">${escapeHtml(tool.engine.relation)}</span></h3>
<p class="note"><code>${escapeHtml(tool.id)}</code>${homepage}</p>
${warning}
${pathsNote}
<div class="table-wrap">
<table>
<thead>
<tr>
<th>Version</th>
<th>Channel</th>
<th>Path</th>
<th>Tested</th>
<th>Corpus</th>
<th>Framing</th>
<th>Vectors</th>
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

function renderResultRow(
  result: AggregateResultSummary,
  aggregate: CompatAggregate,
  toolId: string,
): string {
  if (result.status === 'untested') {
    return `<tr class="untested">
<td>${escapeHtml(result.version)}</td>
<td>${escapeHtml(result.channel)}</td>
<td>${escapeHtml(result.path)}</td>
<td>${renderTimestamp(result.testedAt)}</td>
<td>${renderDigest(result.corpusDigest)}</td>
<td colspan="2" class="reason">untested${result.reason ? `: ${escapeHtml(result.reason)}` : ''}</td>
</tr>`;
  }

  const { summary } = result;
  return `<tr>
<td>${escapeHtml(result.version)}</td>
<td>${escapeHtml(result.channel)}</td>
<td>${escapeHtml(result.path)}</td>
<td>${renderTimestamp(result.testedAt)}</td>
<td>${renderDigest(result.corpusDigest)}</td>
<td>${renderFraming(result.framing, aggregate, toolId)}</td>
<td>${escapeHtml(String(summary.agreed))} agreed, ${escapeHtml(String(summary.diverged))} diverged, ${escapeHtml(String(summary.refused))} refused, ${escapeHtml(String(summary.unsupported))} unsupported of ${escapeHtml(String(summary.total))}</td>
</tr>`;
}

function renderFraming(
  framing: AggregateResultSummary['framing'],
  aggregate: CompatAggregate,
  toolId: string,
): string {
  if (framing === null) return '<span class="framing framing-none">none</span>';
  const badge = `<span class="framing framing-${escapeAttr(framing)}">${escapeHtml(framing)}</span>`;
  return `${badge}<span class="verdict">${framingVerdict(framing, aggregate, toolId)}</span>`;
}

/**
 * The raw framing value stays on the page unchanged (`aggregate.json`'s own
 * field, badge and all), and this is what sits next to it: one sentence a
 * reader who has never opened this repository can act on. `definite` and
 * `cardanoBinary` are anchored to the one reference each side of the divide
 * has that is never itself one of the tools tracked here (`cardano-node` for
 * `cardanoBinary`, the wider JavaScript ecosystem for `definite`, both from
 * spec/07-encoding-divergence.md, "Which one is right"), so the sentence
 * reads the same way on a tool's own row as it does on any other row rather
 * than naming the row's own tool back at it. Which other tracked tool
 * currently lands on the same side is named separately, computed from this
 * page's own data, so that part of the claim is checkable against the rest
 * of the page rather than asserted.
 */
function framingVerdict(
  framing: NonNullable<AggregateResultSummary['framing']>,
  aggregate: CompatAggregate,
  toolId: string,
): string {
  switch (framing) {
    case 'definite':
      return sideVerdict(
        'definite',
        'the framing most wallets and the wider JavaScript ecosystem emit',
        aggregate,
        toolId,
      );
    case 'cardanoBinary':
      return sideVerdict(
        'cardanoBinary',
        'the framing cardano-node itself emits',
        aggregate,
        toolId,
      );
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
  side: string,
  aggregate: CompatAggregate,
  toolId: string,
): string {
  const base = `Produces the ${framing} encoding: ${side}.`;
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
 * Renders a corpus digest as a truncated, monospace badge whose background
 * hue is derived deterministically from the full digest string. Two results
 * that share a `corpusDigest` render the same text and the same color; two
 * that do not are visually distinct even when their truncated prefixes are
 * hard to compare by eye in a dense table. This is a rendering aid only: the
 * full digest is always in the `title` attribute, and the comparison a
 * reader should actually trust is the text, not the color.
 */
function renderDigest(digest: string): string {
  const short = digest.slice(0, 12);
  const hue = hashToHue(digest);
  return `<code class="digest" style="background: hsl(${hue} 70% 88%); color: hsl(${hue} 70% 20%);" title="${escapeAttr(digest)}">${escapeHtml(short)}</code>`;
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

// Defines every term the tables below use, in place rather than linked away,
// because that is where a reader hits the word for the first time. Static
// markup: nothing here depends on the aggregate, so it is a module-level
// constant rather than something rebuilt per render.
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
<dl>
<div>
<dt><code>definite</code></dt>
<dd>A definite-length CBOR array header at every size, including a container of 24 or
more children. What cardano-serialization-lib, MeshJS and most JavaScript tooling
produce.</dd>
</div>
<div>
<dt><code>cardanoBinary</code></dt>
<dd>A definite-length array header up to 23 children, switching to an
indefinite-length header with a closing break byte from 24 up. What cardano-node and
cardano-cli produce.</dd>
</div>
<div>
<dt><code>framing-preserving</code></dt>
<dd>Only reachable on the <code>decode</code> path: the tool returned the hash of the
exact bytes it was handed, whichever of the two encodings that happened to be, instead
of re-encoding first. It has no fixed side of its own; it reflects whatever it was
given.</dd>
</div>
<div>
<dt><code>mixed</code></dt>
<dd>In one run, the tool's answers matched both encodings on different scripts: not
settled on one rule. Never folded into <code>definite</code> or <code>cardanoBinary</code>,
because that would hide the disagreement this value exists to report.</dd>
</div>
<div>
<dt><code>undetermined</code></dt>
<dd>Nothing in this run answered decisively for a script where the two encodings
actually differ, so this run does not yet say which encoding the tool follows.</dd>
</div>
</dl>
<p>Other words this page uses:</p>
<dl>
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
// stylesheet or font is fetched. `color-scheme` plus the `prefers-color-scheme`
// override below are what keep this correct in both light and dark without
// any script deciding at runtime.
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1b1f24;
  --muted: #57606a;
  --border: #d0d7de;
  --accent: #0969da;
  --surface: #f6f8fa;
  --mixed-bg: #fff2cc;
  --mixed-fg: #7a5b00;
  --undetermined-bg: #ffd7d5;
  --undetermined-fg: #82231c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --border: #30363d;
    --accent: #4493f8;
    --surface: #161b22;
    --mixed-bg: #4d3b00;
    --mixed-fg: #ffe38a;
    --undetermined-bg: #5c1b16;
    --undetermined-fg: #ffb3ac;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1rem;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.5;
}
main { max-width: 72rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 0.25rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
h3 { font-size: 1.05rem; margin: 1.25rem 0 0.25rem; }
a { color: var(--accent); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--surface);
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
.lede { color: var(--muted); max-width: 48rem; }
.note { color: var(--muted); font-size: 0.85rem; }
.reason { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; }
.meta { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 1rem 0; padding: 0; }
.meta div { margin: 0; }
.meta dt { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
.meta dd { margin: 0; font-size: 1rem; }
.legend { margin-top: 1.5rem; max-width: 52rem; }
.legend h2 { font-size: 1.1rem; margin-top: 1.5rem; }
.legend > p { color: var(--muted); font-size: 0.9rem; }
.legend dl { margin: 0.75rem 0 1.25rem; }
.legend dl div { margin: 0 0 0.65rem; }
.legend dt { font-weight: 600; }
.legend dd { margin: 0.15rem 0 0; font-size: 0.9rem; }
.warning {
  background: var(--undetermined-bg);
  color: var(--undetermined-fg);
  border-radius: 0.35rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  font-weight: 600;
  max-width: 48rem;
}
.unmeasured { font-style: italic; }
.relation {
  font-size: 0.7rem;
  font-weight: normal;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 0.7rem;
  padding: 0.05rem 0.5rem;
  vertical-align: middle;
}
.table-wrap { overflow-x: auto; margin: 0.5rem 0 1rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.reason { white-space: normal; }
tr.untested { opacity: 0.75; }
.digest { white-space: nowrap; }
.framing {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  border-radius: 0.7rem;
  font-size: 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border);
}
.framing-mixed, .framing-undetermined {
  background: var(--mixed-bg);
  color: var(--mixed-fg);
  border-color: transparent;
  font-weight: 600;
}
.framing-undetermined { background: var(--undetermined-bg); color: var(--undetermined-fg); }
.framing-none { font-style: italic; }
.verdict {
  display: block;
  white-space: normal;
  color: var(--muted);
  font-size: 0.78rem;
  margin-top: 0.2rem;
  max-width: 26rem;
}
@media (max-width: 30rem) {
  body { padding: 0.6rem; }
  h1 { font-size: 1.25rem; }
  th, td { padding: 0.3rem 0.4rem; }
}
`;
