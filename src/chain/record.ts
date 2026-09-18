import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from './evidence.js';
import type { ChainEvidenceEntry, ChainEvidenceNetwork, ChainEvidenceRecord } from './evidence.js';

/**
 * Renders `chain-evidence/observations.json` as a document a person can
 * read straight through, grouped by what each submission establishes rather
 * than by the order entries happen to sit in the file.
 *
 * Every value below is read from the loaded record; nothing here reads the
 * clock, a package version, or anything else that would make two runs over
 * the same JSON produce different bytes. That is what lets `--check` catch
 * drift the same way `compat:aggregate:check` catches a stale aggregate.
 */
export const DEFAULT_CHAIN_EVIDENCE_RECORD_PATH = 'chain-evidence/record.md';

/**
 * `https://preprod.cexplorer.io/tx/<hash>` was fetched for
 * `b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2`, one of
 * this record's own accepted hashes, and returned that transaction's real
 * fee and block, labelled "Preprod"; the same path for a hash that does not
 * exist returns a page that says so. No other candidate resolved: cardanoscan
 * answers every request, valid or not, with a Cloudflare challenge rather
 * than a page, so linking it would be an untested guess. Every entry in
 * `observations.json` is on `preprod` today, and this function returns
 * `null` for any other network rather than emitting a pattern that was never
 * checked against a real hash.
 */
export function explorerTxUrl(network: ChainEvidenceNetwork, txHash: string): string | null {
  if (network === 'preprod') {
    return `https://preprod.cexplorer.io/tx/${txHash}`;
  }
  return null;
}

/** `en-US` is fixed rather than left to the host locale, so this stays byte-stable across machines. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Exported so `chain-evidence-site.ts` states a shape in the same words as this document, rather than a second phrasing that could drift from it. */
export function formatShape(shape: ChainEvidenceEntry['shape']): string | null {
  if (!shape) return null;
  const parts: string[] = [];
  if (shape.depth !== undefined) parts.push(`nesting depth ${formatCount(shape.depth)}`);
  if (shape.keyCount !== undefined) {
    parts.push(`${formatCount(shape.keyCount)} signing keys named in the script`);
  }
  if (shape.scriptBytes !== undefined) {
    parts.push(`script ${formatCount(shape.scriptBytes)} bytes`);
  }
  if (shape.transactionBytes !== undefined) {
    parts.push(`transaction ${formatCount(shape.transactionBytes)} bytes`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/** The prose common to an accepted and a refused entry: what it shows, its shape, and where it was transcribed from. */
function renderDetail(entry: ChainEvidenceEntry): string {
  const segments = [entry.demonstrates.trim()];
  const shape = formatShape(entry.shape);
  if (shape) segments.push(`Shape: ${shape}.`);
  if (entry.vectorId) segments.push(`Corpus vector \`${entry.vectorId}\`.`);
  segments.push(`Source: ${entry.source}.`);
  return segments.join(' ');
}

/**
 * One entry, as a list item. An acceptance is one line: the result, a
 * linked hash, and the prose. A refusal never has a hash to link, so it
 * says that in words, and its verbatim error goes in a fenced block of its
 * own rather than inside the sentence, so nothing in the ledger's message
 * is reformatted, escaped or truncated to fit a line.
 */
function renderEntry(entry: ChainEvidenceEntry): string[] {
  if (entry.accepted) {
    if (!entry.txHash) throw new Error('accepted entry has no txHash');
    const url = explorerTxUrl(entry.network, entry.txHash);
    const hash = `\`${entry.txHash}\``;
    const link = url ? `[${hash}](${url})` : hash;
    return [`- **Accepted** on ${entry.network}, ${link}. ${renderDetail(entry)}`];
  }

  if (!entry.error) throw new Error('refused entry has no error');
  const lines = [
    `- **Refused** on ${entry.network}. No transaction reached a chain. ${renderDetail(entry)}`,
    '',
    '  ```',
    ...entry.error.split('\n').map((line) => `  ${line}`),
    '  ```',
  ];
  return lines;
}

/**
 * One question a reader arrives asking, and the predicate that collects the
 * entries answering it. Matching reads `vectorId` and `source`, the two
 * fields that say what an entry is about, rather than adding a `topic`
 * field to `observations.json` itself: that file is authored by hand and
 * never touched by a generator (`chain-evidence/README.md`), so the
 * taxonomy that groups it has to live here instead.
 *
 * Order here is the order sections appear in the rendered document.
 */
interface ChainEvidenceTopic {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly match: (entry: ChainEvidenceEntry) => boolean;
}

const DEGENERATE_VECTOR_IDS = new Set([
  'degenerate/empty-all',
  'degenerate/empty-atleast-0',
  'degenerate/empty-any',
  'threshold-matrix/atleast-0-of-3',
  'degenerate/atleast-negative',
]);

export const CHAIN_EVIDENCE_TOPICS: readonly ChainEvidenceTopic[] = [
  {
    id: 'degenerate-thresholds',
    title: 'Degenerate thresholds',
    question:
      'What happens to an empty `all`, an empty `any`, or a threshold that is zero or negative?',
    match: (e) => e.vectorId !== undefined && DEGENERATE_VECTOR_IDS.has(e.vectorId),
  },
  {
    id: 'time-bounds',
    title: 'Time bounds and validity intervals',
    question:
      'Does a timelock enforce its bound, and what happens when the transaction states no validity interval at all?',
    match: (e) =>
      e.source.startsWith('spec/03-satisfaction.md, "Extreme and invalid time bounds"') ||
      e.source.startsWith(
        'spec/03-satisfaction.md, "A timelock against an absent interval bound fails"',
      ),
  },
  {
    id: 'malformed-bytes',
    title: 'Malformed and out-of-range script bytes',
    question:
      'What happens to a script, or a slot value inside one, that the CBOR grammar does not admit?',
    // Excludes the degenerate/empty-any acceptance, which cites this same
    // section for a different reason (a reference script is never
    // evaluated) and belongs with the rest of that vector's story instead.
    match: (e) =>
      e.vectorId === undefined &&
      e.source.startsWith(
        'spec/01-script-model.md, "What it takes for a script to reach the chain"',
      ),
  },
  {
    id: 'nesting-depth',
    title: 'Nesting depth',
    question: 'How deep can a single script actually nest before something refuses it?',
    match: (e) =>
      e.source.startsWith('spec/06-chain-exercises.md, "How deep a single script can nest"'),
  },
  {
    id: 'multisig-size',
    title: 'Multisig size ceilings',
    question:
      'How large can a single unanimous multisig be, carried inline and carried by reference?',
    match: (e) =>
      e.source.startsWith('spec/06-chain-exercises.md, "How large a single multisig can be"'),
  },
  {
    id: 'federations',
    title: 'Federations of federations',
    question:
      'How large a federation of member organizations, each governed by its own threshold, can be created and spent?',
    match: (e) =>
      e.source.startsWith(
        'spec/06-chain-exercises.md, "Federations, and which constraint actually binds"',
      ),
  },
  {
    id: 'encoding-divergence',
    title: 'Encoding divergence',
    question:
      'Do the definite and cardano-binary framings of the same script interoperate on chain, or does a node treat them as two different scripts?',
    match: (e) => e.source.startsWith('spec/07-encoding-divergence.md'),
  },
  {
    id: 'drep-credential',
    title: 'The DRep credential, end to end',
    question:
      'Does a native script work as a DRep credential through registration, a vote, an update and retirement?',
    match: (e) => e.source.includes('(DRep)'),
  },
  {
    id: 'stake-credential',
    title: 'The stake credential, end to end',
    question:
      'Does a native script work as a stake credential, and what exactly refuses a delegation?',
    match: (e) =>
      e.source.includes('(stake)') ||
      e.source.includes('"The delegation already tests the script"'),
  },
];

/**
 * Sorts every entry into exactly one topic. Throws rather than dropping an
 * entry silently if none of `CHAIN_EVIDENCE_TOPICS` claims it, or if more
 * than one does: an unclassified or double-classified entry is a taxonomy
 * that has fallen behind the record, the same failure `buildAggregate`
 * raises for a result directory no registered tool claims.
 */
export function classifyChainEvidence(
  entries: readonly ChainEvidenceEntry[],
): Map<string, ChainEvidenceEntry[]> {
  const byTopic = new Map<string, ChainEvidenceEntry[]>(
    CHAIN_EVIDENCE_TOPICS.map((topic) => [topic.id, []]),
  );

  for (const entry of entries) {
    const matches = CHAIN_EVIDENCE_TOPICS.filter((topic) => topic.match(entry));
    if (matches.length === 0) {
      throw new Error(
        `no topic in CHAIN_EVIDENCE_TOPICS matches an entry with source "${entry.source}". ` +
          'Add one, or widen an existing predicate, before regenerating the record.',
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `more than one topic matches an entry with source "${entry.source}": ` +
          `${matches.map((t) => t.id).join(', ')}. Topic predicates must stay disjoint.`,
      );
    }
    byTopic.get(matches[0]!.id)!.push(entry);
  }

  return byTopic;
}

function renderIntro(record: ChainEvidenceRecord): string {
  const accepted = record.entries.filter((e) => e.accepted).length;
  const refused = record.entries.filter((e) => !e.accepted).length;
  const networks = [...new Set(record.entries.map((e) => e.network))].sort();

  const paragraphs = [
    `This is the complete record of every real transaction submitted to ${networks.join(' and ')} and indexed in [\`chain-evidence/observations.json\`](observations.json): ${formatCount(record.entryCount)} submissions in total, ${formatCount(accepted)} accepted and ${formatCount(refused)} refused. Every accepted entry carries the transaction hash a reader can look up independently. Every refused entry carries the ledger's or the decoder's verbatim error in place of a hash, because a refused transaction never reaches a chain.`,
    `This document is generated from \`observations.json\` by \`scripts/chain-evidence-record.ts\` and checked by the same script's \`--check\` mode, wired into \`npm run verify\`, so it cannot drift from the JSON it reads. [\`chain-evidence/README.md\`](README.md) documents that JSON's own format and why it is authored rather than generated. [\`spec/06-chain-exercises.md\`](../spec/06-chain-exercises.md) narrates what these exercises mean and why each ceiling sits where it does; this document does not repeat that narrative, only the enumerated record underneath it, grouped here by the question each submission answers rather than by the order it happens to sit in the file.`,
    `Every accepted hash below links to its transaction on [Cexplorer](https://cexplorer.io/)'s preprod instance, so a reader can confirm the outcome without trusting this repository. A refused submission never reaches a chain and so never has a hash to link; its row states that in words rather than a blank cell.`,
  ];

  return `# Chain evidence, by what each submission establishes\n\n${paragraphs.join('\n\n')}\n`;
}

function renderTopic(topic: ChainEvidenceTopic, entries: ChainEvidenceEntry[]): string {
  const body = entries.flatMap((entry) => renderEntry(entry)).join('\n');
  return `## ${topic.title}

_${topic.question}_

${body}
`;
}

/**
 * The exact bytes this project commits to `chain-evidence/record.md`.
 *
 * Does not re-run `validateChainEvidenceRecord`: `test/unit/chain/evidence.test.ts`
 * already holds the committed JSON to that shape as part of the default
 * offline suite, so by the time this runs in `npm run verify` the record has
 * already passed. `renderEntry` below still refuses, on its own, to render
 * an accepted entry with no hash or a refused entry with no error, because
 * those two are exactly the shapes that would otherwise print as if
 * something were there when it is not.
 */
export function renderChainEvidenceRecord(record: ChainEvidenceRecord): string {
  const byTopic = classifyChainEvidence(record.entries);
  const sections = CHAIN_EVIDENCE_TOPICS.map((topic) =>
    renderTopic(topic, byTopic.get(topic.id) ?? []),
  );

  return `${renderIntro(record)}\n${sections.join('\n')}`;
}

/** Loads `observations.json` and renders it, the pair a caller almost always wants together. */
export async function buildChainEvidenceRecordMarkdown(
  path: string = DEFAULT_CHAIN_EVIDENCE_PATH,
): Promise<string> {
  const record = await loadChainEvidence(path);
  return renderChainEvidenceRecord(record);
}
