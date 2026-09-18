import type {
  ChainEvidenceEntry,
  ChainEvidenceNetwork,
  ChainEvidenceRecord,
} from '../chain/evidence.js';
import {
  CHAIN_EVIDENCE_TOPICS,
  classifyChainEvidence,
  explorerTxUrl,
  formatCount,
  formatShape,
} from '../chain/record.js';
import { escapeAttr, escapeHtml, FAVICON, THEME_TOKENS } from './html.js';

const REPO_BLOB = 'https://github.com/crypto2099/arachne/blob/main';

/**
 * Renders `chain-evidence/observations.json` as the second page of this
 * site, the same relationship `chain-evidence/record.md` has to that JSON
 * on GitHub: nothing here is asserted, every value is read from the loaded
 * record, and the topic grouping is the one `src/chain/record.ts` already
 * uses to write `record.md`, reused rather than re-derived so the two
 * documents cannot classify the same entry two different ways.
 *
 * The compat matrix (`site.ts`) answers whether a piece of software agrees
 * with a rule. This page answers a different question: what has a real
 * node actually done, submission by submission. Neither page substitutes
 * for the other, which is why each links to the other rather than folding
 * one into the second half of a longer page.
 */
export function renderChainEvidenceSite(record: ChainEvidenceRecord): string {
  const accepted = record.entries.filter((e) => e.accepted).length;
  const refused = record.entries.length - accepted;
  const networks = [...new Set(record.entries.map((e) => e.network))].sort();

  const byTopic = classifyChainEvidence(record.entries);
  const sections = CHAIN_EVIDENCE_TOPICS.map((topic) =>
    renderTopicSection(topic.id, topic.title, topic.question, byTopic.get(topic.id) ?? []),
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arachne chain evidence</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
<div class="masthead"></div>
<main>
<header class="page-head">
<div class="page-head-lede">
<h1>Arachne chain evidence</h1>
<p class="lede lede-lead">
Every entry below is a real transaction submitted to a running Cardano network, not a
result computed offline. An accepted entry names the transaction hash a reader can look
up independently; a refused one carries the node's own verbatim error in place of a
hash, because a submission a node refuses never reaches a chain and so never has one.
</p>
<p class="lede">
The <a href="index.html">compat matrix</a> on this site asks whether a piece of software
agrees with a rule. This page asks a narrower question: what has a real node already
done, submission by submission? Each entry is transcribed from
<a href="${REPO_BLOB}/spec/06-chain-exercises.md">spec/06-chain-exercises.md</a> and the
specification documents named on it.
</p>
</div>
<div class="page-head-meta">
<dl class="meta">
<div><dt>Network</dt><dd class="meta-number">${escapeHtml(networks.join(', '))}</dd></div>
<div><dt>Accepted</dt><dd class="meta-number">${escapeHtml(formatCount(accepted))}</dd></div>
<div><dt>Refused</dt><dd class="meta-number">${escapeHtml(formatCount(refused))}</dd></div>
<div><dt>Submissions recorded</dt><dd class="meta-number">${escapeHtml(formatCount(record.entries.length))}</dd></div>
</dl>
<p class="meta-links">
Machine-readable: <a href="chain-evidence.json">chain-evidence.json</a> carries this
whole record. The narrative behind each ceiling is in
<a href="${REPO_BLOB}/spec/06-chain-exercises.md">spec/06-chain-exercises.md</a>; the
authoring rules for the record itself are in
<a href="${REPO_BLOB}/chain-evidence/README.md">chain-evidence/README.md</a>.
</p>
</div>
</header>
${sections}
</main>
</body>
</html>
`;
}

function renderTopicSection(
  id: string,
  title: string,
  question: string,
  entries: readonly ChainEvidenceEntry[],
): string {
  const body = entries.map((entry) => renderEntry(entry)).join('\n');
  return `<section class="topic" id="topic-${escapeAttr(id)}">
<h2>${escapeHtml(title)}</h2>
<p class="question">${renderInlineCode(question)}</p>
<div class="entries">
${body}
</div>
</section>`;
}

function renderEntry(entry: ChainEvidenceEntry): string {
  const detail = renderDetail(entry);

  if (entry.accepted) {
    if (!entry.txHash) throw new Error('accepted entry has no txHash');
    const url = explorerTxUrl(entry.network, entry.txHash);
    const hashMarkup = `<code class="hash">${escapeHtml(entry.txHash)}</code>`;
    const linked = url ? `<a href="${escapeAttr(url)}">${hashMarkup}</a>` : hashMarkup;
    return `<article class="entry entry-accepted">
<p class="entry-head"><span class="verdict verdict-accepted">Accepted</span> on ${renderNetwork(entry.network)}, ${linked}</p>
<p class="entry-body">${detail}</p>
</article>`;
  }

  if (!entry.error) throw new Error('refused entry has no error');
  return `<article class="entry entry-refused">
<p class="entry-head"><span class="verdict verdict-refused">Refused</span> on ${renderNetwork(entry.network)}. No transaction reached a chain.</p>
<p class="entry-body">${detail}</p>
<pre class="error">${escapeHtml(entry.error)}</pre>
</article>`;
}

function renderNetwork(network: ChainEvidenceNetwork): string {
  return `<code>${escapeHtml(network)}</code>`;
}

/** The prose common to an accepted and a refused entry, in the same words `record.md` uses. */
function renderDetail(entry: ChainEvidenceEntry): string {
  const segments = [renderInlineCode(entry.demonstrates.trim())];
  const shape = formatShape(entry.shape);
  if (shape) segments.push(`Shape: ${escapeHtml(shape)}.`);
  if (entry.vectorId) {
    const url = `${REPO_BLOB}/vectors/${entry.vectorId}.json`;
    segments.push(
      `Corpus vector <a href="${escapeAttr(url)}"><code>${escapeHtml(entry.vectorId)}</code></a>.`,
    );
  }
  segments.push(`Source: ${renderSource(entry.source)}.`);
  return segments.join(' ');
}

/** Markdown's one inline construct this record's prose actually uses: a `code span`, turned into `<code>`. */
function renderInlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);
}

const SOURCE_PATH_PATTERN = /^([\w./-]+\.md)(.*)$/;

/** Links the leading `spec/*.md` path a `source` field names to that file on GitHub, keeping the quoted section after it as plain text. */
function renderSource(source: string): string {
  const match = SOURCE_PATH_PATTERN.exec(source);
  if (!match) return escapeHtml(source);
  const path = match[1]!;
  const rest = match[2] ?? '';
  return `<a href="${escapeAttr(`${REPO_BLOB}/${path}`)}"><code>${escapeHtml(path)}</code></a>${escapeHtml(rest)}`;
}

// Reuses the palette and typefaces `site.ts` draws from the same
// `THEME_TOKENS`, so the two pages read as one site, plus the rules this
// page's own layout needs: a two-state `entry` card (accepted, solid;
// refused, dashed) rather than the five-way `side` system the compat matrix
// draws, because what varies here is whether a chain accepted a submission,
// not which of two encodings a tool produced.
const STYLE = `${THEME_TOKENS}
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
.masthead { height: 5px; background: var(--section-rule); }
main { max-width: 74rem; margin: 0 auto; padding: 2.5rem 1.25rem 0; }
h1 {
  font-size: clamp(2rem, 1.4rem + 2.2vw, 2.75rem);
  line-height: 1.12;
  letter-spacing: -0.018em;
  font-weight: 600;
  margin: 0 0 1rem;
}
h2 { font-size: 1.5rem; line-height: 1.2; letter-spacing: -0.012em; font-weight: 600; margin: 0 0 0.4rem; }
p { margin: 0 0 0.9rem; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 2px; }
code, time, .hash, .verdict, .meta-number { font-family: var(--mono); font-variant-ligatures: none; }
code {
  font-size: 0.86em;
  background: var(--rule-soft);
  padding: 0.05em 0.32em;
  border-radius: 3px;
  overflow-wrap: anywhere;
}
.lede { max-width: 38rem; margin: 0 0 1rem; }
.lede-lead { font-size: 1.1875rem; line-height: 1.55; }
.page-head { display: grid; gap: 2rem; margin: 0 0 2rem; }
@media (min-width: 62rem) {
  .page-head { grid-template-columns: minmax(0, 38rem) minmax(15rem, 1fr); gap: 3.5rem; align-items: start; }
}
.page-head-lede > :last-child { margin-bottom: 0; }
.page-head-meta { display: grid; gap: 1rem; align-content: start; }
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
.meta-number { font-size: 1.35rem; line-height: 1.15; }
.meta-links { margin: 0; color: var(--ink-2); font-size: 0.875rem; line-height: 1.5; padding-left: 1.25rem; }
.topic { margin: 0 0 2.75rem; scroll-margin-top: 1rem; }
.topic h2 { border-top: 2px solid var(--section-rule); padding-top: 0.85rem; }
.question { color: var(--ink-2); font-size: 0.9375rem; max-width: 46rem; }
.entries { display: grid; gap: 0.75rem; }
.entry {
  position: relative;
  padding: 0.85rem 1rem 0.9rem 1.15rem;
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 8px;
}
.entry::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.85rem;
  bottom: 0.9rem;
  width: 4px;
  border-radius: 2px;
}
.entry-accepted::before { background: var(--node); }
.entry-refused::before {
  background: repeating-linear-gradient(to bottom, var(--ink-2) 0 5px, transparent 5px 9px);
}
.entry-head { margin: 0 0 0.35rem; font-size: 0.95rem; }
.entry-body { margin: 0; font-size: 0.9375rem; line-height: 1.55; }
.verdict {
  display: inline-block;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--rule);
  background: var(--rule-soft);
}
.verdict-accepted { background: var(--node-tint); border-color: var(--node-line); color: var(--node-ink); }
.verdict-refused { color: var(--ink-2); }
.error {
  margin: 0.6rem 0 0;
  padding: 0.6rem 0.75rem;
  background: var(--rule-soft);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 0.8125rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-2);
}
@media (max-width: 34rem) {
  main { padding-left: 1rem; padding-right: 1rem; }
}
`;
