import { escapeAttr, escapeHtml, FAVICON, THEME_TOKENS } from '../html.js';

export const REPO_URL = 'https://github.com/crypto2099/arachne';
export const REPO_BLOB = `${REPO_URL}/blob/main`;

/** Which entry in the site navigation the page being rendered belongs to. */
export type NavKey = 'libraries' | 'chain' | 'methods' | 'data' | 'none';

export interface Crumb {
  label: string;
  /** Relative to the page being rendered. Absent on the last crumb, the page itself. */
  href?: string;
}

export interface PageOptions {
  /** The document title, without the site name; the shell appends it. */
  title: string;
  /** Path from the page's directory back to the site root: `''`, `'../'` or `'../../'`. */
  root: string;
  current: NavKey;
  crumbs?: Crumb[];
  body: string;
}

const NAV: readonly { key: NavKey; href: string; label: string }[] = [
  { key: 'libraries', href: 'index.html', label: 'Libraries' },
  { key: 'chain', href: 'chain-evidence.html', label: 'Chain evidence' },
  { key: 'methods', href: 'methods.html', label: 'How to read this' },
  { key: 'data', href: 'methods.html#data', label: 'Data files' },
];

/**
 * The frame every page shares: the masthead motif, the site navigation, an
 * optional breadcrumb, the page body and a footer naming the source of the
 * data. There is no `<script>` and no off-origin reference anywhere in the
 * output, so a page renders identically with the network switched off; the
 * stylesheet is inline and the type is a system stack for the same reason.
 */
export function renderPage(options: PageOptions): string {
  const { title, root, current, crumbs, body } = options;
  const links = NAV.map(({ key, href, label }) => {
    const mark = key === current ? ' aria-current="page"' : '';
    return `<li><a href="${escapeAttr(root + href)}"${mark}>${escapeHtml(label)}</a></li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}, Arachne</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head>
<body>
<header class="site-head">
<div class="masthead" aria-hidden="true"></div>
<nav class="site-nav" aria-label="Site">
<a class="wordmark" href="${escapeAttr(root)}index.html">Arachne</a>
<ul>
${links}
<li><a href="${REPO_URL}">GitHub</a></li>
</ul>
</nav>
</header>
<main>
${crumbs ? renderCrumbs(crumbs) : ''}
${body}
</main>
<footer class="site-foot">
<p>Every value on this site is read from data committed to the
<a href="${REPO_URL}">Arachne repository</a>: results of running real tool releases, and
transactions a real node accepted or refused. Nothing is computed by hand and nothing on a
page is fetched by the browser. The site is rebuilt when a change to that data merges.</p>
<p>Machine-readable copies: <a href="${escapeAttr(root)}aggregate.json">aggregate.json</a>,
<a href="${escapeAttr(root)}version.json">version.json</a>,
<a href="${escapeAttr(root)}chain-evidence.json">chain-evidence.json</a>,
<a href="${escapeAttr(root)}scripts.json">scripts.json</a>.
See <a href="${escapeAttr(root)}methods.html#data">how to read them</a>.</p>
</footer>
</body>
</html>
`;
}

function renderCrumbs(crumbs: Crumb[]): string {
  const items = crumbs
    .map((crumb) =>
      crumb.href === undefined
        ? `<li aria-current="page">${escapeHtml(crumb.label)}</li>`
        : `<li><a href="${escapeAttr(crumb.href)}">${escapeHtml(crumb.label)}</a></li>`,
    )
    .join('\n');
  return `<nav class="crumbs" aria-label="Breadcrumb">\n<ol>\n${items}\n</ol>\n</nav>`;
}

// Two families carry one rule: a value a machine produced is set in the
// monospace face, and everything a person wrote is set in the serif. That is
// why versions, timestamps, digests and error text are monospace while the
// labels beside them are not; the label is a name, the value is a reading.
//
// Five colours, each meaning one thing everywhere on the site: gold for the
// definite-length-everywhere framing, blue for the Haskell rule that switches
// at 24 items, green for a correct hash, red for a wrong one, plum for a
// refusal. A chip's left mark restates its framing in a pattern (unbroken
// for definite, segmented for the switch at 24, alternating for a tool that
// keeps whatever it was given), so nothing is carried by colour alone.
const STYLE = `${THEME_TOKENS}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 1.0625rem;
  line-height: 1.6;
}
main { max-width: 74rem; margin: 0 auto; padding: 1.75rem 1.25rem 3rem; }
h1 {
  font-size: clamp(1.75rem, 1.25rem + 1.8vw, 2.5rem);
  line-height: 1.12;
  letter-spacing: -0.015em;
  font-weight: 600;
  margin: 0 0 0.75rem;
  max-width: 40rem;
}
h2 {
  font-size: 1.45rem;
  line-height: 1.2;
  letter-spacing: -0.01em;
  font-weight: 600;
  margin: 2.5rem 0 0.75rem;
  padding-top: 0.75rem;
  border-top: 2px solid var(--section-rule);
}
h3 { font-size: 1.15rem; line-height: 1.25; font-weight: 600; margin: 1.5rem 0 0.5rem; }
h4 { font-size: 1rem; line-height: 1.3; font-weight: 600; margin: 1.25rem 0 0.4rem; }
p, ul, ol, dl { margin: 0 0 0.9rem; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 2px; }
code, pre, time, .mono { font-family: var(--mono); font-variant-ligatures: none; }
code { font-size: 0.86em; background: var(--rule-soft); padding: 0.05em 0.32em; border-radius: 3px; overflow-wrap: anywhere; }
pre {
  margin: 0.5rem 0 0;
  padding: 0.6rem 0.75rem;
  background: var(--rule-soft);
  border-radius: 6px;
  font-size: 0.8125rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-2);
}
.prose, .lede { max-width: 40rem; }
.lede { font-size: 1.125rem; line-height: 1.55; }
.muted { color: var(--ink-2); }
.small { font-size: 0.875rem; line-height: 1.5; }
.hash { overflow-wrap: anywhere; }

/* The site's one decoration: two rules of equal weight, one unbroken and one
   segmented, the two framings this whole site is about. */
.masthead {
  height: 6px;
  background-image:
    linear-gradient(var(--gold), var(--gold)),
    repeating-linear-gradient(to right, var(--blue) 0 14px, transparent 14px 22px);
  background-size: 50% 100%, 50% 100%;
  background-position: left top, right top;
  background-repeat: no-repeat;
}
.site-nav {
  max-width: 74rem;
  margin: 0 auto;
  padding: 0.9rem 1.25rem 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 2rem;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.8rem;
}
.wordmark { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
.site-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1.4rem; }
.site-nav li a { color: var(--ink-2); text-decoration: none; font-size: 0.9375rem; padding: 0.15rem 0; }
.site-nav li a:hover { color: var(--ink); text-decoration: underline; }
.site-nav li a[aria-current="page"] { color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--ink); }
.crumbs { margin: 0 0 1.25rem; font-size: 0.875rem; color: var(--ink-2); }
.crumbs ol { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.2rem 0; }
.crumbs li + li::before { content: "/"; margin: 0 0.5rem; color: var(--rule); }
.crumbs a { color: var(--ink-2); }
.site-foot {
  max-width: 74rem;
  margin: 0 auto;
  padding: 1.25rem 1.25rem 3rem;
  border-top: 1px solid var(--rule);
  color: var(--ink-2);
  font-size: 0.875rem;
  line-height: 1.5;
}
.site-foot p { max-width: 46rem; margin: 0 0 0.6rem; }

/* Facts beside a heading: label above value, several across. */
.facts { display: flex; flex-wrap: wrap; gap: 0.75rem 2rem; margin: 0 0 1.25rem; padding: 0; }
.facts div { margin: 0; }
.facts dt { font-size: 0.8125rem; color: var(--ink-2); line-height: 1.35; }
.facts dd { margin: 0.05rem 0 0; font-size: 0.9375rem; line-height: 1.4; }

/* Chips: one word or phrase carrying a framing or an outcome, tinted in the
   one colour that value owns. The framing chips add a left mark whose
   pattern restates the value. */
.chip {
  display: inline-block;
  font-size: 0.8125rem;
  line-height: 1.45;
  padding: 0.08rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--rule);
  background: var(--rule-soft);
  color: var(--ink);
  white-space: nowrap;
  vertical-align: 0.05em;
}
.chip-definite, .chip-indef, .chip-keep, .chip-mixed, .chip-undet { padding-left: 1.1rem; position: relative; }
.chip-definite::before, .chip-indef::before, .chip-keep::before, .chip-mixed::before, .chip-undet::before {
  content: "";
  position: absolute;
  left: 0.45rem;
  top: 0.32rem;
  bottom: 0.32rem;
  width: 3px;
  border-radius: 1.5px;
  background: var(--mark);
}
.chip-definite { --mark: var(--gold); background: var(--gold-tint); border-color: var(--gold-line); color: var(--gold-ink); }
.chip-indef { --mark: repeating-linear-gradient(to bottom, var(--blue) 0 3px, transparent 3px 5px); background: var(--blue-tint); border-color: var(--blue-line); color: var(--blue-ink); }
.chip-keep { --mark: repeating-linear-gradient(to bottom, var(--gold) 0 3px, var(--blue) 3px 6px); background: var(--ok-tint); border-color: var(--ok-line); color: var(--ok-ink); }
.chip-mixed { --mark: repeating-linear-gradient(135deg, var(--gold) 0 2px, var(--blue) 2px 4px); }
.chip-undet { --mark: repeating-linear-gradient(to bottom, var(--ink-2) 0 2px, transparent 2px 4px); }
.chip-ok { background: var(--ok-tint); border-color: var(--ok-line); color: var(--ok-ink); }
.chip-bad { background: var(--bad-tint); border-color: var(--bad-line); color: var(--bad-ink); font-weight: 600; }
.chip-refused { background: var(--plum-tint); border-color: var(--plum-line); color: var(--plum-ink); }
.chip-unsup { background: var(--rule-soft); border-color: var(--rule); color: var(--ink-2); }
.chip-none { background: transparent; border-style: dashed; color: var(--ink-2); }
.chip-blue { background: var(--blue-tint); border-color: var(--blue-line); color: var(--blue-ink); }
.chip-gold { background: var(--gold-tint); border-color: var(--gold-line); color: var(--gold-ink); }

/* Outcome counts, in a sentence or a cell: a non-zero problem count is the
   thing to see, so a zero is not printed at all. */
.counts { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; }

/* Findings on the home page and problems on a tool page: a card whose left
   rule carries the outcome colour. */
.findings, .problems { list-style: none; margin: 0 0 1.5rem; padding: 0; display: grid; gap: 0.6rem; }
.finding, .problem {
  position: relative;
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 0.75rem 1rem 0.8rem 1.15rem;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.finding::before, .problem::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -1px;
  bottom: -1px;
  width: 5px;
  border-radius: 6px 0 0 6px;
  background: var(--edge, var(--rule));
}
.edge-bad { --edge: var(--bad); }
.edge-refused { --edge: var(--plum); }
.edge-unsup { --edge: var(--ink-2); }
.edge-none { --edge: repeating-linear-gradient(to bottom, var(--ink-2) 0 4px, transparent 4px 8px); }
.edge-ok { --edge: var(--ok); }
.edge-gold { --edge: var(--gold); }
.edge-blue { --edge: repeating-linear-gradient(to bottom, var(--blue) 0 8px, transparent 8px 13px); }
.finding p, .problem p { margin: 0 0 0.35rem; }
.finding p:last-child, .problem p:last-child { margin-bottom: 0; }
.problem-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.6rem; margin: 0 0 0.35rem; }
.problem-head strong { font-weight: 600; }
.problem pre { margin-top: 0.4rem; }
.script-list { list-style: none; margin: 0 0 0.4rem; padding: 0; font-size: 0.9rem; line-height: 1.5; }
.script-list li { margin: 0 0 0.3rem; padding-left: 0.9rem; text-indent: -0.9rem; }
.script-list li:last-child { margin-bottom: 0; }

/* Verdict blocks on a tool page: one per question. */
.verdicts { display: grid; gap: 0.75rem; margin: 0 0 1rem; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); }
.verdict {
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 0.85rem 1rem 0.9rem;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.verdict h3 { margin: 0 0 0.4rem; font-size: 1.05rem; }
.verdict p { margin: 0 0 0.45rem; }
.verdict p:last-child { margin-bottom: 0; }

/* Tables. One layout rule for all of them: header in the serif, values in
   whichever face the value calls for, and under 60rem the header row hides
   and each cell prints its own label, so no table ever scrolls sideways. */
.table-wrap { overflow-x: auto; margin: 0 0 1.5rem; }
table.grid { border-collapse: collapse; width: 100%; font-size: 0.9rem; background: var(--card); border: 1px solid var(--rule); border-radius: 6px; }
table.grid th, table.grid td { text-align: left; vertical-align: top; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--rule-soft); }
table.grid th { font-weight: 600; font-size: 0.8125rem; color: var(--ink-2); background: var(--rule-soft); }
table.grid tbody tr:last-child td { border-bottom: 0; }
table.grid td.mono, table.grid td .mono { font-size: 0.8125rem; }
table.grid tr.group th { background: var(--card); color: var(--ink); font-size: 0.9rem; padding-top: 0.75rem; border-top: 1px solid var(--rule); }
table.grid td .cell-line { display: block; }
table.grid td .cell-line + .cell-line { margin-top: 0.3rem; }
table.grid td.tool-name a { font-weight: 600; color: var(--ink); }
table.grid td .sub { display: block; color: var(--ink-2); font-size: 0.8125rem; line-height: 1.45; }
table.grid a.cell-link { color: inherit; text-decoration: none; display: block; }
table.grid a.cell-link:hover .cell-line:last-child { text-decoration: underline; }

/* Terms defined once on the methods page. */
dl.terms div { margin: 0 0 1rem; max-width: 46rem; }
dl.terms dt { font-weight: 600; margin: 0 0 0.15rem; }
dl.terms dd { margin: 0; font-size: 0.9375rem; line-height: 1.5; color: var(--ink-2); }
dl.terms dd code, dl.terms dt code { font-size: 0.82em; }

/* Chain evidence entries. */
.topic-index { list-style: none; margin: 0 0 1.5rem; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; font-size: 0.9375rem; }
.entries { display: grid; gap: 0.6rem; margin: 0 0 1rem; }
.entry {
  position: relative;
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 0.75rem 1rem 0.8rem 1.15rem;
  font-size: 0.9375rem;
  line-height: 1.5;
  scroll-margin-top: 1rem;
}
.entry::before { content: ""; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 5px; border-radius: 6px 0 0 6px; background: var(--edge, var(--rule)); }
.entry-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.6rem; margin: 0 0 0.35rem; }
.entries > * { min-width: 0; }
.entry, .problem, .finding { overflow-wrap: anywhere; }
.entry-hash { font-size: 0.8125rem; }
.entry-body { margin: 0; }
.entry-meta { margin: 0.35rem 0 0; font-size: 0.8125rem; color: var(--ink-2); }

details { margin: 0 0 1rem; }
summary { cursor: pointer; font-weight: 600; font-size: 0.9375rem; }
.id-list { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem 0.8rem; font-size: 0.8125rem; }

.question { color: var(--ink-2); font-size: 0.9375rem; max-width: 46rem; margin: 0 0 1rem; }
.note { color: var(--ink-2); font-size: 0.875rem; line-height: 1.5; max-width: 46rem; }
.callout { background: var(--card); border: 1px solid var(--rule); border-radius: 6px; padding: 0.85rem 1rem; max-width: 46rem; margin: 0 0 1.25rem; font-size: 0.9375rem; }
.callout p:last-child { margin-bottom: 0; }

@media (max-width: 60rem) {
  main { padding-top: 1.25rem; }
  .table-wrap { overflow-x: visible; }
  table.grid, table.grid tbody, table.grid tr, table.grid td { display: block; width: 100%; }
  table.grid thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  table.grid { border: 0; background: transparent; }
  table.grid tr { background: var(--card); border: 1px solid var(--rule); border-radius: 6px; padding: 0.5rem 0.8rem; margin: 0 0 0.6rem; }
  table.grid tr.group { background: transparent; border: 0; padding: 0.5rem 0 0; margin: 0; }
  table.grid tr.group th { display: block; background: transparent; border: 0; padding: 0; }
  table.grid td, table.grid tbody tr:last-child td {
    border: 0;
    padding: 0.2rem 0;
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: 0.6rem;
    overflow-wrap: anywhere;
  }
  table.grid td::before { content: attr(data-label); color: var(--ink-2); font-size: 0.8125rem; line-height: 1.5; }
  table.grid td.tool-name { grid-template-columns: 1fr; }
  table.grid td.tool-name::before { display: none; }
  .chip { white-space: normal; }
}
@media (max-width: 34rem) {
  main, .site-nav, .site-foot { padding-left: 1rem; padding-right: 1rem; }
  .site-nav { gap: 0.4rem 1rem; }
  .site-nav ul { gap: 0.2rem 0.9rem; }
  table.grid td, table.grid tbody tr:last-child td { grid-template-columns: 1fr; gap: 0.1rem; }
}
`;
