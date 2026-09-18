import { escapeHtml } from '../html.js';
import type { SiteData } from './data.js';
import { renderPage, REPO_BLOB } from './shell.js';
import {
  CHANNEL_LABEL,
  formatCount,
  FRAMING_LABEL,
  OUTCOME_LABEL,
  PATH_TITLE,
} from './vocabulary.js';

/**
 * The one page that defines every term the site uses, so no other page has
 * to. Every other page links here at the word's first use. The last section
 * maps each word on the site to the identifier the JSON files carry, so a
 * program and a person reading the same result can agree on what it says.
 */
export function renderMethodsPage(data: SiteData): string {
  const root = '';
  const vectorCount = formatCount(data.corpus.vectorCount);
  const scriptCount = formatCount(data.observed.scriptCount);

  const body = `<h1>How to read this site</h1>
<p class="lede">Arachne is a harness and conformance corpus for Cardano native scripts. It
establishes what a native script can be and what the tools that build and read them actually
do, from evidence a reader can check: a real release of a library, run against a script, with the
result recorded verbatim. This page defines every term the other pages use.</p>

<h2 id="framings">The two ways to frame a list</h2>
<p class="prose">A native script is stored as CBOR. Each container in it, an <span class="mono">all</span>,
<span class="mono">any</span> or <span class="mono">atLeast</span>, holds a list of sub-scripts, and
CBOR allows a list to be written two ways: with its length in the header, or as an open list
closed by a break byte. Both are valid, both decode to the same script, and the ledger accepts
both.</p>
<p class="prose">The Haskell implementation that cardano-node and cardano-cli are built on writes
the length in the header for a list of up to 23 items and switches to the open form from 24
items. That rule sits in its CBOR library, and it is what this site calls
<strong>${escapeHtml(FRAMING_LABEL.cardanoBinary)}</strong>. Most other implementations, in Rust,
TypeScript, Go, Java and Python, write the length in the header at every size, which this site
calls <strong>${escapeHtml(FRAMING_LABEL.definite)}</strong>.</p>
<p class="prose">A script's hash is taken over its bytes. So a script with any list of 24 or more
items has two valid hashes, one per framing, and therefore two addresses and two governance
identifiers. Neither is canonical. An address derived with a library on one side of the rule and
a transaction built with a library on the other refer to two different scripts as far as the
ledger is concerned. The chain evidence for this is under
<a href="${root}chain-evidence.html#topic-encoding-divergence">Encoding divergence</a>, and the
full account is <a href="${REPO_BLOB}/spec/07-encoding-divergence.md">spec/07-encoding-divergence.md</a>.</p>
<p class="prose">A script whose lists are all shorter than 24 items has one encoding under both
rules. Those scripts say nothing about which rule a library follows, which is why a run's framing
is read only from the scripts where the two differ.</p>
<dl class="terms">
<div><dt><span class="chip chip-definite">${escapeHtml(FRAMING_LABEL.definite)}</span></dt><dd>The library wrote every list with its length in the header. On a question that hands the library bytes, it means the library decoded them and re-encoded this way before hashing.</dd></div>
<div><dt><span class="chip chip-indef">${escapeHtml(FRAMING_LABEL.cardanoBinary)}</span></dt><dd>The library wrote the length in the header up to 23 items and an open list from 24, the Haskell rule. On a question that hands the library bytes, it re-encoded this way before hashing.</dd></div>
<div><dt><span class="chip chip-keep">${escapeHtml(FRAMING_LABEL['framing-preserving'])}</span></dt><dd>Only possible on a question that hands the library bytes. The hash it returned was the hash of the exact bytes it was given, whichever framing they carried. This is the correct behaviour for a script that already exists.</dd></div>
<div><dt><span class="chip chip-mixed">${escapeHtml(FRAMING_LABEL.mixed)}</span></dt><dd>In one run the library's answers matched one framing on some scripts and the other on others. Reported as it is, never folded into either side.</dd></div>
<div><dt><span class="chip chip-undet">${escapeHtml(FRAMING_LABEL.undetermined)}</span></dt><dd>No script in the run distinguished the two framings, so the run does not say which rule the library follows.</dd></div>
</dl>

<h2 id="questions">The three questions</h2>
<dl class="terms">
<div id="building"><dt>${escapeHtml(PATH_TITLE.construct)}</dt><dd>The library is given the structure of each of the ${vectorCount} corpus scripts, builds it through its own API, and hashes the result. Correct means the hash matches one of the two valid hashes the corpus records for that script. This is what a library does when it authors a script from scratch, and its framing here is the framing every script it builds will carry.</dd></div>
<div id="round-tripping"><dt>${escapeHtml(PATH_TITLE.decode)}</dt><dd>The library is handed each corpus script's exact bytes, once in each framing, and asked for the hash. Correct means the hash matches either valid hash. The framing read off this question says whether the library hashes what it was given or re-encodes it first.</dd></div>
<div id="chain-scripts"><dt>${escapeHtml(PATH_TITLE['decode-onchain'])}</dt><dd>The library is handed the bytes of each of the ${scriptCount} distinct native scripts a Cardano node has accepted in a real transaction, and asked for the hash. Correct means the hash is the one those bytes have on chain, and nothing else counts: a script that exists on a chain has one hash, and a library that returns the other framing's hash would derive an address that holds no funds. The scripts, and the transactions that carried them, are listed under <a href="${root}chain-evidence.html#scripts">Chain evidence</a>.</dd></div>
</dl>
<p class="prose">Not every library is asked every question. A library that is not set up to be asked
one shows <span class="chip chip-none">Not asked</span> for it; one that is set up but has no
result yet shows <span class="chip chip-none">Not run yet</span>. Both are different from a release
that was tried and could not be installed, which is recorded with the installer's own text.</p>

<h2 id="outcomes">Outcomes for one script</h2>
<dl class="terms">
<div><dt><span class="chip chip-ok">${escapeHtml(OUTCOME_LABEL.agreed)}</span></dt><dd>The library returned a hash and it was a right one, as each question defines it.</dd></div>
<div><dt><span class="chip chip-bad">${escapeHtml(OUTCOME_LABEL.diverged)}</span></dt><dd>The library returned a hash and it was not one. On the chain-script question this is the finding that matters most: a live script, and a hash the chain does not have. The result page says which framing the wrong hash corresponds to, so the cause is visible.</dd></div>
<div><dt><span class="chip chip-refused">${escapeHtml(OUTCOME_LABEL.refused)}</span></dt><dd>The library was given the script and declined, with an error, a crash or a timeout. Its own text is kept verbatim.</dd></div>
<div><dt><span class="chip chip-unsup">${escapeHtml(OUTCOME_LABEL.unsupported)}</span></dt><dd>The library's API cannot express the construct, so it was never asked. Recorded ahead of the attempt, with the reason.</dd></div>
</dl>

<h2 id="releases">Releases</h2>
<p class="prose">Up to three releases of each library are tracked: the ${escapeHtml(CHANNEL_LABEL.current)},
the ${escapeHtml(CHANNEL_LABEL.previous)}, and a ${escapeHtml(CHANNEL_LABEL.beta)} when one is newer
than the latest release. The home page shows the latest release's answer, because that is what a
reader installing the library today gets. A library's own page lists every tested release, and
lists each problem once with the releases it was seen in, so a fix or a regression shows up as a
change in that list.</p>
<p class="prose">Two results are directly comparable only when they were measured against the same
set. Each result page names the digest of the set it ran against and says whether that is the set
committed today.</p>

<h2 id="encoders">Libraries and the encoders under them</h2>
<p class="prose">Several libraries do not encode scripts themselves. They sit on a shared encoder,
as a dependency, a fork or a private copy, and inherit whatever it does. Two libraries on one
encoder agreeing is one observation about that encoder, not two, and that is how the site counts
them: a library's page says which encoder it uses and names any other tracked library on the
same one. A library that reimplements a rule independently, sharing no code, is separate
evidence, and so is one with its own encoder.</p>
<p class="prose">Each library's page also says what it is written in and where a user calls it
from, because those are different things for a Rust library shipped to npm as WebAssembly.</p>

<h2 id="data">Data files</h2>
<p class="prose">Everything on this site is rendered from files committed to the repository, and
each is served here unchanged beside the pages:</p>
<dl class="terms">
<div><dt><a href="${root}aggregate.json">aggregate.json</a></dt><dd>Every library, its encoder, and a summary of every result: version, channel, question, framing and counts. Documented in <a href="${REPO_BLOB}/compat/README.md">compat/README.md</a>.</dd></div>
<div><dt><a href="${root}version.json">version.json</a></dt><dd>A digest of the aggregate and its counts, small enough to poll to decide whether to fetch the aggregate again.</dd></div>
<div><dt><span class="mono">results/&lt;library&gt;/&lt;release&gt;[-&lt;question&gt;].json</span></dt><dd>One file per result, with every script's outcome, hash and verbatim error. Linked from the bottom of each result page.</dd></div>
<div><dt><a href="${root}chain-evidence.json">chain-evidence.json</a></dt><dd>Every real submission to a Cardano network this project cites, accepted or refused, with transaction hashes and the node's own errors.</dd></div>
<div><dt><a href="${root}scripts.json">scripts.json</a></dt><dd>The distinct native scripts extracted from those transactions, exactly as the bytes arrived, with the transactions that carried each one. This is the set the chain-script question is measured against.</dd></div>
</dl>

<h2 id="json-words">Words on this site and the identifiers in the files</h2>
<p class="prose">The files keep short identifiers that programs depend on. This site names what each
one means instead. The mapping:</p>
<div class="table-wrap">
<table class="grid">
<thead><tr><th scope="col">On this site</th><th scope="col">In the files</th></tr></thead>
<tbody>
${mappingRows([
  [FRAMING_LABEL.definite, '"framing": "definite"'],
  [FRAMING_LABEL.cardanoBinary, '"framing": "cardanoBinary"'],
  [FRAMING_LABEL['framing-preserving'], '"framing": "framing-preserving"'],
  [FRAMING_LABEL.mixed, '"framing": "mixed"'],
  [FRAMING_LABEL.undetermined, '"framing": "undetermined"'],
  [PATH_TITLE.construct, '"path": "construct"'],
  [PATH_TITLE.decode, '"path": "decode"'],
  [PATH_TITLE['decode-onchain'], '"path": "decode-onchain"'],
  [OUTCOME_LABEL.agreed, '"status": "agreed"'],
  [OUTCOME_LABEL.diverged, '"status": "diverged"'],
  [OUTCOME_LABEL.refused, '"status": "refused"'],
  [OUTCOME_LABEL.unsupported, '"status": "unsupported"'],
  [CHANNEL_LABEL.current, '"channel": "current"'],
  [CHANNEL_LABEL.previous, '"channel": "previous"'],
  [CHANNEL_LABEL.beta, '"channel": "beta"'],
  ['Could not be installed', '"status": "untested"'],
  [
    'Definite-length bytes, indefinite-length bytes',
    '"inputFraming": "definite" or "cardanoBinary"',
  ],
  ['Encoder', '"engine"'],
  ['Corpus script', 'a vector under vectors/'],
])}
</tbody>
</table>
</div>
<p class="note">The identifier <span class="mono">cardanoBinary</span> is the name of the Haskell CBOR library whose rule it describes. It is kept in the files because results, tests and downstream consumers already use it.</p>`;

  return renderPage({ title: 'How to read this site', root, current: 'methods', body });
}

function mappingRows(pairs: [string, string][]): string {
  return pairs
    .map(
      ([word, json]) =>
        `<tr><td data-label="On this site">${escapeHtml(word)}</td><td data-label="In the files" class="mono">${escapeHtml(json)}</td></tr>`,
    )
    .join('\n');
}
