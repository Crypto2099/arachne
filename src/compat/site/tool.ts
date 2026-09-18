import type { AggregateTool } from '../aggregate.js';
import type { CompatResult } from '../result-schema.js';
import { CONSTRUCTION_PATHS, type ConstructionPath } from '../types.js';
import { escapeAttr, escapeHtml } from '../html.js';
import type { SiteData } from './data.js';
import { describeScript, explainDivergence, renderCarriers, renderScriptId } from './describe.js';
import type { Problem, ProblemGroup } from './summaries.js';
import {
  framingChip,
  OUTCOME_EDGE,
  outcomeChip,
  outcomeCounts,
  releasePhrase,
  resultLink,
  setPhrase,
  timestamp,
  toolLink,
} from './render.js';
import { renderPage } from './shell.js';
import {
  errorVariants,
  groupProblems,
  pathState,
  problemsAcrossReleases,
  resultPagePath,
} from './summaries.js';
import {
  CHANNEL_LABEL,
  formatCount,
  framingSentence,
  joinNames,
  OUTCOME_LABEL,
  PATH_TITLE,
  plural,
  relationPhrase,
} from './vocabulary.js';

/**
 * One library's page: what it is and what it is built on, its latest answer
 * to each question, every problem found in any tested release with the
 * tool's verbatim text, and the table of releases. A problem that repeats
 * across releases is listed once with the releases it was seen in, so the
 * page grows with what changed rather than with how often it was run.
 */
export function renderToolPage(data: SiteData, tool: AggregateTool): string {
  const root = '../';
  const results = data.results.get(tool.id) ?? [];
  const engine = data.aggregate.engines.find((e) => e.id === tool.engine.id);
  const engineName = engine?.displayName ?? tool.engine.id;
  const engineLink = engine?.homepage
    ? `<a href="${escapeAttr(engine.homepage)}">${escapeHtml(engineName)}</a>`
    : escapeHtml(engineName);
  const relation = relationPhrase(tool.engine.relation, engineName);
  const releaseCount = new Set(results.map((r) => r.version)).size;

  const facts = `<dl class="facts">
<div><dt>Written in</dt><dd>${escapeHtml(tool.language ?? 'Unstated')}</dd></div>
<div><dt>Used from</dt><dd>${escapeHtml(tool.usedFrom ?? 'Unstated')}</dd></div>
<div><dt>Encoder</dt><dd>${tool.engine.relation === 'own' ? 'Its own' : `${engineLink}, ${escapeHtml(relation)}`}</dd></div>
<div><dt>Source</dt><dd><a href="${escapeAttr(tool.homepage)}">${escapeHtml(tool.homepage.replace(/^https?:\/\//, ''))}</a></dd></div>
<div><dt>Releases tested</dt><dd>${formatCount(releaseCount)}</dd></div>
</dl>`;

  const body = `<h1>${escapeHtml(tool.displayName)}</h1>
${facts}
${renderSharedEngineNote(data, tool, root)}
<h2 id="verdicts">Latest release, by question</h2>
<div class="verdicts">
${CONSTRUCTION_PATHS.map((path) => renderVerdict(tool, results, path, root)).join('\n')}
</div>
<h2 id="problems">Problems found, across every tested release</h2>
${renderProblems(data, results, root)}
<h2 id="releases">Every tested release</h2>
${renderReleases(results, root)}`;

  return renderPage({
    title: tool.displayName,
    root,
    current: 'libraries',
    crumbs: [{ label: 'Libraries', href: `${root}index.html` }, { label: tool.displayName }],
    body,
  });
}

/**
 * Said only where it applies: another tracked library sits on the same
 * encoder without reimplementing it, so the two agreeing is one observation
 * about that encoder rather than two.
 */
function renderSharedEngineNote(data: SiteData, tool: AggregateTool, root: string): string {
  const sharing = data.aggregate.tools.filter(
    (other) => other.id !== tool.id && !tool.independentOf.includes(other.id),
  );
  if (sharing.length === 0) return '';
  const names = sharing.map((t) => toolLink(t, root)).join(', ');
  return `<p class="note">Shares its encoder with ${names}. Where they agree, that is one observation about the encoder, not one per library.</p>`;
}

function renderVerdict(
  tool: AggregateTool,
  results: readonly CompatResult[],
  path: ConstructionPath,
  root: string,
): string {
  const state = pathState(tool, results, path);
  const heading = `<h3>${escapeHtml(PATH_TITLE[path])}</h3>`;
  switch (state.kind) {
    case 'unmeasured':
      return `<div class="verdict">${heading}<p><span class="chip chip-none">Not asked</span></p><p class="muted">This library is not yet set up to be asked this question, so nothing has been measured.</p></div>`;
    case 'pending':
      return `<div class="verdict">${heading}<p><span class="chip chip-none">Not run yet</span></p><p class="muted">Registered for this question, with no result recorded yet.</p></div>`;
    case 'result': {
      const { result } = state;
      const link = resultLink(result, root, 'Full result');
      if (result.status === 'untested') {
        return `<div class="verdict">${heading}<p><span class="chip chip-none">Could not be installed</span> ${releasePhrase(result)}</p><pre>${escapeHtml(result.reason ?? '')}</pre><p>${link}.</p></div>`;
      }
      const framing =
        result.framing === null
          ? ''
          : `<p>${framingChip(result.framing, path)}</p><p class="muted">${escapeHtml(framingSentence(result.framing, path))}</p>`;
      return `<div class="verdict">${heading}<p>${outcomeCounts(result.summary)}</p>${framing}<p class="muted">Release ${releasePhrase(result)}, against ${escapeHtml(setPhrase(path, result.summary.total))}. ${link}.</p></div>`;
    }
  }
}

function renderProblems(data: SiteData, results: readonly CompatResult[], root: string): string {
  const groups = groupProblems(problemsAcrossReleases(results));
  const tested = results.filter((r) => r.status === 'tested');
  if (groups.length === 0) {
    if (tested.length === 0)
      return '<p class="prose">No release of this library has been tested yet.</p>';
    return `<p class="prose">None. Every script in every tested release came back correct.</p>`;
  }
  const scripts = new Set(groups.flatMap((g) => g.problems.map((p) => p.vectorId))).size;
  const items = groups.map((g) => renderProblemGroup(data, g, results, root)).join('\n');
  return `<p class="prose">${formatCount(groups.length)} ${plural(groups.length, 'problem')} across ${formatCount(scripts)} ${plural(scripts, 'script')}, each listed once with the releases it was seen in. Wrong hashes first, then refusals, then constructs the library cannot represent.</p>
<ul class="problems">
${items}
</ul>`;
}

function inputPhrase(framing: Problem['inputFraming']): string {
  switch (framing) {
    case 'definite':
      return 'definite-length bytes';
    case 'cardanoBinary':
      return 'indefinite-length bytes';
    default:
      return '';
  }
}

/**
 * One card per group: the scripts it covers, what the tool returned or said,
 * and which releases it was seen in. The verbatim text is printed once per
 * distinct wording, not once per script.
 */
function renderProblemGroup(
  data: SiteData,
  group: ProblemGroup,
  results: readonly CompatResult[],
  root: string,
): string {
  const releasesOnPath = [
    ...new Set(
      results.filter((r) => r.path === group.path && r.status === 'tested').map((r) => r.version),
    ),
  ];
  const seen = [...new Set(group.problems.flatMap((p) => p.occurrences.map((o) => o.version)))];
  const mono = (v: string): string => `<span class="mono">${escapeHtml(v)}</span>`;
  const seenIn =
    seen.length === releasesOnPath.length
      ? `Seen in every tested release (${seen.map(mono).join(', ')}).`
      : `Seen in ${seen.map(mono).join(', ')}; not in ${releasesOnPath
          .filter((v) => !seen.includes(v))
          .map(mono)
          .join(', ')}.`;

  // One line per script. On the round-trip question the same script can
  // appear once per framing of its bytes, so those are merged into one line
  // that says which framings were affected.
  const byScript = new Map<string, Problem[]>();
  for (const problem of group.problems) {
    const list = byScript.get(problem.vectorId) ?? [];
    list.push(problem);
    byScript.set(problem.vectorId, list);
  }
  const givenFor = (problems: Problem[]): string => {
    const framings = problems
      .map((p) => inputPhrase(p.inputFraming))
      .filter((s) => s !== '')
      .sort();
    if (framings.length === 0) return '';
    return framings.length === 1 ? `given the ${framings[0]}` : 'given either framing';
  };

  // Corpus scripts have ids that already say what they are, so a long group
  // of them is a family sentence and a list of ids, with the shape of each
  // one on its own page. Chain scripts are named by hash, so each one keeps
  // its description and the transaction that carried it.
  const compact = group.path !== 'decode-onchain' && byScript.size > 3;
  let scripts: string;
  if (compact) {
    const families = [
      ...new Set([...byScript.keys()].map((id) => data.vectors.get(id)?.family ?? id)),
    ].sort();
    const givens = new Set([...byScript.values()].map(givenFor));
    const given = givens.size === 1 ? [...givens][0]! : '';
    const familyPhrase = `from the ${joinNames(families.map((f) => `<span class="mono">${escapeHtml(f)}</span>`))} ${plural(families.length, 'family', 'families')}`;
    const ids = [...byScript.entries()]
      .map(([id, problems]) => {
        const description = describeScript(data, group.path, id);
        const note = given === '' ? givenFor(problems) : '';
        return `<li><a class="mono" href="${escapeAttr(description.href)}" title="${escapeAttr(description.summary)}">${escapeHtml(id)}</a>${note ? ` <span class="muted">(${escapeHtml(note)})</span>` : ''}</li>`;
      })
      .join('\n');
    scripts = `<p>${formatCount(byScript.size)} scripts ${familyPhrase}${given ? `, ${escapeHtml(given)}` : ''}:</p>
<ul class="id-list">
${ids}
</ul>`;
  } else {
    const lines = [...byScript.entries()].map(([id, problems]) => {
      const description = describeScript(data, group.path, id);
      const given = givenFor(problems);
      const carriers = renderCarriers(description, root);
      let returned = '';
      if (group.status === 'diverged') {
        const hashes = [
          ...new Set(
            problems
              .flatMap((p) => p.occurrences.map((o) => o.hash))
              .filter((h) => h !== undefined),
          ),
        ];
        returned = ` Returned <span class="mono hash">${escapeHtml(hashes[0] ?? '')}</span>${hashes.length > 1 ? ` in the latest release, and ${formatCount(hashes.length - 1)} other ${plural(hashes.length - 1, 'hash', 'hashes')} in earlier ones` : ''}.`;
      }
      return `<li>${renderScriptId(description, group.path)}${given ? `, ${escapeHtml(given)}` : ''}: ${escapeHtml(description.summary)}.${carriers ? ` ${carriers}` : ''}${returned}</li>`;
    });
    scripts = `<ul class="script-list">
${lines.join('\n')}
</ul>`;
  }

  const detail: string[] = [];
  if (group.status === 'diverged') {
    const sample = group.problems[0]!.occurrences[0];
    detail.push(
      `<p>${escapeHtml(explainDivergence({ id: '', status: 'diverged', ...(sample?.matchedFraming === undefined ? {} : { matchedFraming: sample.matchedFraming }) }, group.path))}</p>`,
    );
  } else {
    const variants = new Map<string, Set<string>>();
    for (const problem of group.problems) {
      for (const variant of errorVariants(problem)) {
        const versions = variants.get(variant.error) ?? new Set<string>();
        for (const v of variant.versions) versions.add(v);
        variants.set(variant.error, versions);
      }
    }
    for (const [error, versions] of variants) {
      const from =
        variants.size > 1
          ? `<p class="small muted">Text from ${[...versions].map(mono).join(', ')}.</p>`
          : '';
      detail.push(`<pre>${escapeHtml(error)}</pre>${from}`);
    }
  }

  const count = byScript.size;
  const head =
    count === 1
      ? `<strong>${escapeHtml(PATH_TITLE[group.path])}</strong>`
      : `<strong>${escapeHtml(PATH_TITLE[group.path])}</strong> <span class="muted">${formatCount(count)} scripts</span>`;

  return `<li class="problem ${OUTCOME_EDGE[group.status]}">
<p class="problem-head">${outcomeChip(group.status)} ${head}</p>
${scripts}
${detail.join('\n')}
<p class="small muted">${seenIn}</p>
</li>`;
}

function renderReleases(results: readonly CompatResult[], root: string): string {
  if (results.length === 0)
    return '<p class="prose">No release of this library has been tested yet.</p>';
  const ordered = [...results].sort((a, b) => {
    // `results` arrive highest version first; keep that and order the questions within a version.
    if (a.version !== b.version) return results.indexOf(a) - results.indexOf(b);
    return CONSTRUCTION_PATHS.indexOf(a.path) - CONSTRUCTION_PATHS.indexOf(b.path);
  });
  const rows = ordered.map((r) => {
    const href = escapeAttr(root + resultPagePath(r));
    const outcome =
      r.status === 'untested'
        ? `<span class="chip chip-none">Could not be installed</span>`
        : outcomeCounts(r.summary);
    const framing =
      r.status === 'untested' || r.framing === null ? '' : framingChip(r.framing, r.path);
    return `<tr>
<td data-label="Release" class="mono">${escapeHtml(r.version)}</td>
<td data-label="Channel">${escapeHtml(CHANNEL_LABEL[r.channel])}</td>
<td data-label="Question"><a href="${href}">${escapeHtml(PATH_TITLE[r.path])}</a></td>
<td data-label="Tested">${timestamp(r.testedAt)}</td>
<td data-label="Framing">${framing}</td>
<td data-label="Outcome">${outcome}</td>
</tr>`;
  });
  return `<div class="table-wrap">
<table class="grid">
<thead>
<tr>
<th scope="col">Release</th>
<th scope="col">Channel</th>
<th scope="col">Question</th>
<th scope="col">Tested</th>
<th scope="col">Framing</th>
<th scope="col">Outcome</th>
</tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>
<p class="note">Outcome words: ${Object.values(OUTCOME_LABEL)
    .map((w) => escapeHtml(w))
    .join(
      ', ',
    )}. Each is defined on <a href="${root}methods.html#outcomes">How to read this site</a>.</p>`;
}
