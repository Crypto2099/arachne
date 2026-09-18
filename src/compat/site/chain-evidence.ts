import type { ChainEvidenceEntry } from '../../chain/evidence.js';
import type { ObservedScriptRecord } from '../../chain/observed.js';
import {
  CHAIN_EVIDENCE_TOPICS,
  classifyChainEvidence,
  explorerTxUrl,
  formatShape,
} from '../../chain/record.js';
import type { VectorStatus } from '../classify.js';
import { escapeAttr, escapeHtml } from '../html.js';
import type { SiteData } from './data.js';
import { describeShape } from './describe.js';
import { outcomeChip, resultLink } from './render.js';
import { renderPage, REPO_BLOB } from './shell.js';
import { latestResult } from './summaries.js';
import { formatCount, OUTCOME_ORDER, plural } from './vocabulary.js';

/**
 * Every real submission this project cites, grouped by the question each one
 * answers, in the same grouping `chain-evidence/record.md` uses so the two
 * cannot classify an entry differently. Each accepted entry is anchored by
 * its transaction hash, which is what the result pages link to when a
 * script a library got wrong came from that transaction.
 *
 * The last section turns the same record round: the distinct scripts those
 * transactions carried, and what each library's latest release did with
 * them. That is the per-script view of the chain-script question, where the
 * home page has the per-library one.
 */
export function renderChainEvidencePage(data: SiteData): string {
  const root = '';
  const record = data.chainEvidence;
  const accepted = record.entries.filter((e) => e.accepted).length;
  const refused = record.entries.length - accepted;
  const networks = [...new Set(record.entries.map((e) => e.network))].sort();
  const byTopic = classifyChainEvidence(record.entries);

  const index = CHAIN_EVIDENCE_TOPICS.map(
    (topic) =>
      `<li><a href="#topic-${escapeAttr(topic.id)}">${escapeHtml(topic.title)}</a> <span class="muted">(${formatCount((byTopic.get(topic.id) ?? []).length)})</span></li>`,
  ).join('\n');
  const sections = CHAIN_EVIDENCE_TOPICS.map((topic) =>
    renderTopic(topic.id, topic.title, topic.question, byTopic.get(topic.id) ?? []),
  ).join('\n');

  const body = `<h1>What a real node has accepted and refused</h1>
<p class="lede">Every entry here is a real transaction submitted to a running Cardano network. An
accepted entry names a transaction hash a reader can look up on an explorer. A refused one carries
the node's own error in place of a hash, because a submission a node refuses never reaches a chain.
Nothing on this page was computed offline.</p>
<dl class="facts">
<div><dt>Network</dt><dd>${escapeHtml(networks.join(', '))}</dd></div>
<div><dt>Submissions</dt><dd>${formatCount(record.entries.length)}</dd></div>
<div><dt>Accepted</dt><dd>${formatCount(accepted)}</dd></div>
<div><dt>Refused</dt><dd>${formatCount(refused)}</dd></div>
<div><dt>Distinct scripts carried</dt><dd><a href="#scripts">${formatCount(data.observed.scriptCount)}</a></dd></div>
</dl>
<p class="prose">Each entry is transcribed from the specification document it names, and the
narrative behind each ceiling is in <a href="${REPO_BLOB}/spec/06-chain-exercises.md">spec/06-chain-exercises.md</a>.
The libraries page asks whether software agrees with a rule; this page asks what a node has
actually done, submission by submission.</p>
<ul class="topic-index">
${index}
<li><a href="#scripts">The scripts those transactions carried</a></li>
</ul>
${sections}
${renderScripts(data, root)}`;

  return renderPage({ title: 'Chain evidence', root, current: 'chain', body });
}

function renderTopic(
  id: string,
  title: string,
  question: string,
  entries: readonly ChainEvidenceEntry[],
): string {
  const body = entries.map((entry) => renderEntry(entry)).join('\n');
  return `<section id="topic-${escapeAttr(id)}">
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
    const hash = `<span class="mono entry-hash">${escapeHtml(entry.txHash)}</span>`;
    const linked = url ? `<a href="${escapeAttr(url)}">${hash}</a>` : hash;
    return `<article class="entry edge-ok" id="tx-${escapeAttr(entry.txHash)}">
<p class="entry-head"><span class="chip chip-ok">Accepted</span> on ${escapeHtml(entry.network)}${entry.observedAt ? `, ${escapeHtml(entry.observedAt.slice(0, 10))}` : ''}</p>
<p class="entry-body">${detail}</p>
<p class="entry-meta">Transaction ${linked}</p>
</article>`;
  }

  if (!entry.error) throw new Error('refused entry has no error');
  return `<article class="entry edge-refused">
<p class="entry-head"><span class="chip chip-refused">Refused</span> on ${escapeHtml(entry.network)}${entry.observedAt ? `, ${escapeHtml(entry.observedAt.slice(0, 10))}` : ''}. No transaction reached a chain.</p>
<p class="entry-body">${detail}</p>
<pre>${escapeHtml(entry.error)}</pre>
</article>`;
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

/**
 * The distinct scripts a node has carried, each with what every library's
 * latest release did when handed its bytes. A library with no result on the
 * chain-script question is not listed against a script, because absence of
 * a result is not an outcome.
 */
function renderScripts(data: SiteData, root: string): string {
  const chainTools = data.aggregate.tools
    .map((tool) => ({
      tool,
      result: latestResult(data.results.get(tool.id) ?? [], 'decode-onchain'),
    }))
    .filter((t) => t.result !== undefined && t.result.status === 'tested');

  const rows = data.observed.scripts.map((script) => renderScriptRow(script, chainTools, root));
  const measured = chainTools.length;

  return `<section id="scripts">
<h2>The scripts those transactions carried</h2>
<p class="question">${formatCount(data.observed.scriptCount)} distinct native scripts, extracted from the accepted transactions above exactly as their bytes arrived. Each is what ${formatCount(measured)} ${plural(measured, 'library', 'libraries')} ${plural(measured, 'was', 'were')} handed on the chain-script question; the last column is what each one's latest release returned.</p>
<div class="table-wrap">
<table class="grid">
<thead>
<tr>
<th scope="col">Script</th>
<th scope="col">What it is</th>
<th scope="col">Carried by</th>
<th scope="col">Latest releases</th>
</tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>
<p class="note">The full set, with each script's bytes, is <a href="${root}scripts.json">scripts.json</a>.</p>
</section>`;
}

function renderScriptRow(
  script: ObservedScriptRecord,
  chainTools: {
    tool: { id: string; displayName: string };
    result: ReturnType<typeof latestResult>;
  }[],
  root: string,
): string {
  const bits: string[] = [];
  if (script.shape) bits.push(describeShape(script.shape));
  else if (script.decodeError) bits.push("bytes this project's own decoder cannot read");
  bits.push(`${formatCount(script.scriptBytes)} bytes`);
  if (script.framings && script.framings.length === 1) {
    bits.push(
      script.framings[0] === 'cardanoBinary'
        ? 'carries an indefinite-length list'
        : 'carries a definite-length list of 24 or more',
    );
  }
  if (script.vectorId) {
    bits.push(
      `the same bytes as corpus vector <a href="${escapeAttr(`${REPO_BLOB}/vectors/${script.vectorId}.json`)}"><span class="mono">${escapeHtml(script.vectorId)}</span></a>`,
    );
  }
  const what =
    bits.map((b, i) => (i === bits.length - 1 && script.vectorId ? b : escapeHtml(b))).join('; ') +
    (script.decodeError && !script.shape
      ? `<span class="sub">${escapeHtml(script.decodeError)}</span>`
      : '');

  const carriers = script.carriedBy
    .map(
      (c) =>
        `<a href="#tx-${escapeAttr(c.txHash)}" title="${escapeAttr(c.txHash)}"><span class="mono">${escapeHtml(c.txHash.slice(0, 12))}</span></a> (${escapeHtml(c.location)})`,
    )
    .join(', ');

  const byOutcome = new Map<VectorStatus, string[]>(OUTCOME_ORDER.map((s) => [s, []]));
  for (const { tool, result } of chainTools) {
    const answer = result!.vectors.find((v) => v.id === script.scriptHash);
    if (!answer) continue;
    byOutcome
      .get(answer.status)!
      .push(resultLink(result!, root, `${tool.displayName} ${result!.version}`));
  }
  const lines = OUTCOME_ORDER.filter((s) => (byOutcome.get(s) ?? []).length > 0).map(
    (s) =>
      `<span class="cell-line">${outcomeChip(s, byOutcome.get(s)!.length)}: ${byOutcome.get(s)!.join(', ')}</span>`,
  );

  return `<tr>
<td data-label="Script" class="mono"><span title="${escapeAttr(script.scriptHash)}">${escapeHtml(script.scriptHash.slice(0, 12))}</span></td>
<td data-label="What it is">${what}</td>
<td data-label="Carried by">${carriers}</td>
<td data-label="Latest releases">${lines.length > 0 ? lines.join('\n') : '<span class="muted">No library has been handed this script yet.</span>'}</td>
</tr>`;
}
