import type { AggregateResultSummary, AggregateTool, CompatAggregate } from './aggregate.js';
import type { CompatVersionDocument } from './version.js';
import type { EngineDefinition } from './types.js';

/**
 * Renders the compat matrix as one self-contained HTML document: everything
 * the "for humans" half of the site needs, built once at deploy time from
 * the committed aggregate rather than fetched by the browser. There is no
 * `<script>` anywhere in the output: every value below is baked into the
 * markup at render time, which is what "must not fetch anything client-side"
 * means in practice, not merely "no XHR call written down anywhere".
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
    .map((engine) => renderEngineSection(engine, toolsByEngineId.get(engine.id) ?? []))
    .join('\n');

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
Which currently installable release of which Cardano tool agrees with which native-script
encoding, measured by running each one against the vectors committed under
<code>vectors/</code>. See <a href="https://github.com/crypto2099/arachne/blob/main/compat/README.md">compat/README.md</a>
for the full data model.
</p>
<dl class="meta">
<div><dt>Last tested</dt><dd>${renderTimestamp(aggregate.latestTestedAt)}</dd></div>
<div><dt>Tools tracked</dt><dd>${escapeHtml(String(version.toolCount))}</dd></div>
<div><dt>Results recorded</dt><dd>${escapeHtml(String(version.resultCount))}</dd></div>
<div><dt>Aggregate digest (sha256)</dt><dd><code class="digest">${escapeHtml(version.aggregateDigest)}</code></dd></div>
</dl>
<p class="lede">
Machine-readable: <a href="aggregate.json">aggregate.json</a> carries this whole matrix,
<a href="version.json">version.json</a> is small enough to poll on a schedule to decide whether to
refetch it.
</p>
<p class="note">
Two results are only directly comparable when their <strong>corpus</strong> column matches; the
color is a visual aid for spotting that at a glance, not a judgment about the result. A
<span class="framing framing-mixed">mixed</span> or
<span class="framing framing-undetermined">undetermined</span> framing is a finding on its own,
never folded into a neighboring value.
</p>
</header>
${engineSections}
</main>
</body>
</html>
`;
}

function renderEngineSection(engine: EngineDefinition, tools: AggregateTool[]): string {
  const homepage = engine.homepage
    ? ` &middot; <a href="${escapeHtml(engine.homepage)}">source</a>`
    : '';
  const note = engine.note ? `<p class="note">${escapeHtml(engine.note)}</p>` : '';
  const toolSections = tools.length
    ? tools.map(renderToolSection).join('\n')
    : '<p class="note">No tool in the registry currently sits on this engine.</p>';

  return `<section class="engine">
<h2 id="engine-${escapeAttr(engine.id)}">${escapeHtml(engine.displayName)}</h2>
<p class="note">engine id <code>${escapeHtml(engine.id)}</code>${homepage}</p>
${note}
${toolSections}
</section>`;
}

function renderToolSection(tool: AggregateTool): string {
  const homepage = tool.homepage
    ? ` &middot; <a href="${escapeHtml(tool.homepage)}">source</a>`
    : '';
  const independentOf = tool.independentOf.length
    ? `<p class="note">Independent evidence alongside: ${tool.independentOf
        .map((id) => `<code>${escapeHtml(id)}</code>`)
        .join(', ')}</p>`
    : '<p class="note">No other tracked tool is independent evidence for this one (either none share the corpus, or every peer shares this one&rsquo;s engine).</p>';

  const rows = tool.results.length
    ? tool.results.map(renderResultRow).join('\n')
    : '<tr><td colspan="7" class="note">No result recorded yet.</td></tr>';

  return `<article class="tool">
<h3 id="tool-${escapeAttr(tool.id)}">${escapeHtml(tool.displayName)} <span class="relation">${escapeHtml(tool.engine.relation)}</span></h3>
<p class="note"><code>${escapeHtml(tool.id)}</code>${homepage}</p>
${independentOf}
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

function renderResultRow(result: AggregateResultSummary): string {
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
<td>${renderFraming(result.framing)}</td>
<td>${escapeHtml(String(summary.agreed))} agreed, ${escapeHtml(String(summary.diverged))} diverged, ${escapeHtml(String(summary.refused))} refused, ${escapeHtml(String(summary.unsupported))} unsupported of ${escapeHtml(String(summary.total))}</td>
</tr>`;
}

function renderFraming(framing: AggregateResultSummary['framing']): string {
  if (framing === null) return '<span class="framing framing-none">none</span>';
  return `<span class="framing framing-${escapeAttr(framing)}">${escapeHtml(framing)}</span>`;
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
@media (max-width: 30rem) {
  body { padding: 0.6rem; }
  h1 { font-size: 1.25rem; }
  th, td { padding: 0.3rem 0.4rem; }
}
`;
