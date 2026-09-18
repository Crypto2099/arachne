import type { AggregateTool } from '../aggregate.js';
import type { VectorResult, VectorStatus } from '../classify.js';
import type { CompatResult } from '../result-schema.js';
import { escapeAttr, escapeHtml } from '../html.js';
import type { SiteData } from './data.js';
import { describeScript, explainDivergence, renderCarriers, renderScriptId } from './describe.js';
import {
  framingChip,
  OUTCOME_EDGE,
  outcomeChip,
  outcomeCounts,
  setPhrase,
  timestamp,
} from './render.js';
import { renderPage, REPO_BLOB } from './shell.js';
import { groupByOutcome, resultFileStem, toolPagePath } from './summaries.js';
import {
  CHANNEL_LABEL,
  formatCount,
  framingSentence,
  OUTCOME_HEADING,
  OUTCOME_ORDER,
  PATH_CORRECT_MEANS,
  PATH_QUESTION,
  PATH_TITLE,
  plural,
} from './vocabulary.js';

/**
 * One result file as a page: which release, which question, which set it was
 * measured against, and then every script that came back wrong, refused or
 * unrepresentable, each with what the tool returned or said. The correct
 * ones are listed last and collapsed, because a reader arrives to find out
 * what went wrong, and the count already says how many went right.
 */
export function renderResultPage(
  data: SiteData,
  tool: AggregateTool,
  result: CompatResult,
): string {
  const root = '../../';
  const title = `${tool.displayName} ${result.version}: ${PATH_TITLE[result.path].toLowerCase()}`;
  const jsonName = `${resultFileStem(result)}.json`;
  const currentDigest =
    result.path === 'decode-onchain' ? data.observed.digest : data.corpus.digest;
  const setName =
    result.path === 'decode-onchain' ? 'chain-evidence/scripts.json' : 'vectors/index.json';
  const digestNote =
    result.corpusDigest === currentDigest
      ? 'the current set'
      : `an earlier version of the set than the one committed today, so its counts are not directly comparable with a result made against the current one`;

  const facts = `<dl class="facts">
<div><dt>Release</dt><dd><span class="mono">${escapeHtml(result.version)}</span>, ${escapeHtml(CHANNEL_LABEL[result.channel])}</dd></div>
<div><dt>Tested</dt><dd>${timestamp(result.testedAt)}</dd></div>
<div><dt>Encoder version resolved</dt><dd>${renderEngineVersion(result)}</dd></div>
<div><dt>Harness</dt><dd><span class="mono">${escapeHtml(result.arachneVersion)}</span></dd></div>
</dl>`;

  let body = `<h1>${escapeHtml(title)}</h1>
<p class="question">${escapeHtml(PATH_QUESTION[result.path])}</p>
${facts}`;

  if (result.status === 'untested') {
    body += `<div class="callout">
<p><span class="chip chip-none">Could not be installed</span> This release could not be installed, so nothing was measured. The installer's own text:</p>
<pre>${escapeHtml(result.reason ?? '')}</pre>
</div>`;
  } else {
    const set = setPhrase(result.path, result.summary.total);
    body += `<div class="callout">
<p>${outcomeCounts(result.summary)}${result.framing === null ? '' : ` ${framingChip(result.framing, result.path)}`}</p>
<p>Correct means ${escapeHtml(PATH_CORRECT_MEANS[result.path])}. Measured against ${escapeHtml(set)}, ${digestNote} (<span class="mono">${escapeHtml(setName)}</span> digest <span class="mono hash" title="${escapeAttr(result.corpusDigest)}">${escapeHtml(result.corpusDigest.slice(0, 12))}</span>).</p>
${result.framing === null ? '' : `<p>${escapeHtml(framingSentence(result.framing, result.path))}</p>`}
</div>
${renderOutcomeSections(data, result, root)}`;
  }

  body += `<p class="note">Rendered from <a href="${escapeAttr(jsonName)}">${escapeHtml(jsonName)}</a>, served beside this page, and committed at <a href="${escapeAttr(`${REPO_BLOB}/compat/results/${tool.id}/${jsonName}`)}">compat/results/${escapeHtml(tool.id)}/${escapeHtml(jsonName)}</a>. Every value on this page is read from that file; the words for each value are defined on <a href="${root}methods.html#json-words">How to read this site</a>.</p>`;

  return renderPage({
    title,
    root,
    current: 'libraries',
    crumbs: [
      { label: 'Libraries', href: `${root}index.html` },
      { label: tool.displayName, href: `${root}${toolPagePath(tool.id)}` },
      { label: `${result.version}, ${PATH_TITLE[result.path].toLowerCase()}` },
    ],
    body,
  });
}

function renderEngineVersion(result: CompatResult): string {
  const { engine } = result;
  if (engine.resolvedVersion !== null) {
    return `<span class="mono">${escapeHtml(engine.id)} ${escapeHtml(engine.resolvedVersion)}</span>`;
  }
  return `${escapeHtml(engine.id)}${engine.note ? `, ${escapeHtml(engine.note)}` : ''}`;
}

function renderOutcomeSections(data: SiteData, result: CompatResult, root: string): string {
  const groups = groupByOutcome(result.vectors);
  const sections: string[] = [];
  for (const status of OUTCOME_ORDER) {
    const vectors = groups.get(status) ?? [];
    if (vectors.length === 0) continue;
    sections.push(
      status === 'agreed'
        ? renderCorrect(data, result, vectors)
        : renderProblemSection(data, result, status, vectors, root),
    );
  }
  return sections.join('\n');
}

function inputPhrase(vector: VectorResult): string {
  switch (vector.inputFraming) {
    case 'definite':
      return 'given the definite-length bytes';
    case 'cardanoBinary':
      return 'given the indefinite-length bytes';
    default:
      return '';
  }
}

function renderProblemSection(
  data: SiteData,
  result: CompatResult,
  status: Exclude<VectorStatus, 'agreed'>,
  vectors: VectorResult[],
  root: string,
): string {
  // When every wrong hash on the page came about the same way, the
  // explanation is given once above the list rather than under each script.
  const explanations = new Set(
    status === 'diverged' ? vectors.map((v) => explainDivergence(v, result.path)) : [],
  );
  const sharedExplanation =
    explanations.size === 1 && vectors.length > 1
      ? [...explanations][0]!
          .replace(/^This is the hash/, 'Each is the hash')
          .replace(/^The hash is/, 'Each hash is')
          .replace(/^The hash matches/, 'Each hash matches')
          .replace(
            /^Neither framing of this script produces this hash/,
            'Neither framing produces these hashes',
          )
      : '';

  const items = vectors.map((vector) => {
    const description = describeScript(data, result.path, vector.id);
    const input = inputPhrase(vector);
    const carriers = renderCarriers(description, root);
    const note = description.note
      ? `<p class="small muted">${escapeHtml(description.note)}</p>`
      : '';
    let detail: string;
    if (status === 'diverged') {
      const why = sharedExplanation ? '' : ` ${escapeHtml(explainDivergence(vector, result.path))}`;
      detail = `<p>Returned <span class="mono hash">${escapeHtml(vector.hash ?? '')}</span>.${why}</p>`;
    } else {
      detail = `<pre>${escapeHtml(vector.error ?? '')}</pre>`;
    }
    return `<li class="problem ${OUTCOME_EDGE[status]}">
<p class="problem-head">${outcomeChip(status)} ${renderScriptId(description, result.path)}${input ? ` <span class="muted">${escapeHtml(input)}</span>` : ''}</p>
<p>${escapeHtml(description.summary)}.${carriers ? ` ${carriers}` : ''}</p>
${note}${detail}
</li>`;
  });

  const intro: Record<Exclude<VectorStatus, 'agreed'>, string> = {
    diverged:
      result.path === 'decode-onchain'
        ? 'The tool returned a hash, and it is not the hash these bytes have on chain. An address or credential derived from it does not exist on any chain.'
        : 'The tool returned a hash that matches neither valid encoding of the script.',
    refused: 'The tool was given the script and declined, with the text below.',
    unsupported:
      'The tool cannot represent the construct, so it was never asked. The text below says why.',
  };

  return `<h2 id="${escapeAttr(status)}">${escapeHtml(OUTCOME_HEADING[status])}: ${formatCount(vectors.length)} of ${formatCount(result.summary.total)}</h2>
<p class="prose">${escapeHtml(intro[status])}${sharedExplanation ? ` ${escapeHtml(sharedExplanation)}` : ''}</p>
<ul class="problems">
${items.join('\n')}
</ul>`;
}

function renderCorrect(data: SiteData, result: CompatResult, vectors: VectorResult[]): string {
  // On the round-trip question a script appears twice, once per framing of
  // its bytes; list it once and say which framings it was correct for.
  const byId = new Map<string, VectorResult[]>();
  for (const vector of vectors) {
    const list = byId.get(vector.id) ?? [];
    list.push(vector);
    byId.set(vector.id, list);
  }
  const items = [...byId.entries()].map(([id, answers]) => {
    const description = describeScript(data, result.path, id);
    let note = '';
    if (result.path === 'decode' && answers.length === 1) {
      note = ` <span class="muted">(${escapeHtml(inputPhrase(answers[0]!))})</span>`;
    }
    return `<li>${renderScriptId(description, result.path)}${note}</li>`;
  });
  const total = vectors.length;
  return `<h2 id="agreed">${escapeHtml(OUTCOME_HEADING.agreed)}: ${formatCount(total)} of ${formatCount(result.summary.total)}</h2>
<details>
<summary>${formatCount(byId.size)} ${plural(byId.size, 'script')} the tool got right</summary>
<ul class="id-list">
${items.join('\n')}
</ul>
</details>`;
}
