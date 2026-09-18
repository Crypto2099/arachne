import type { ObservedScriptRecord } from '../../chain/observed.js';
import { explorerTxUrl } from '../../chain/record.js';
import type { ScriptShape } from '../../model/invariants.js';
import type { VectorResult } from '../classify.js';
import type { ConstructionPath } from '../types.js';
import { escapeAttr, escapeHtml } from '../html.js';
import type { SiteData, VectorSummary } from './data.js';
import { REPO_BLOB } from './shell.js';
import { formatCount, plural } from './vocabulary.js';

/**
 * How a page names one script a result is about. On the two corpus questions
 * that is a vector id such as `breadth/all-w024`; on the chain question it is
 * a script hash, because an observed script has no name beyond the bytes a
 * transaction carried.
 */
export interface ScriptDescription {
  /** The identifier as the result file records it. */
  id: string;
  /** One line saying what the script is, for a heading or a table cell. */
  summary: string;
  /** Where the script itself can be read, on GitHub or on this site. */
  href: string;
  /** For an observed script, the transactions a node accepted it in. */
  carriers?: { network: string; txHash: string; location: string; href: string | null }[];
  /** Verbatim text worth showing beside the summary on a page with room for it. */
  note?: string;
}

/** A short, plain reading of a script's shape: what it is made of. */
export function describeShape(shape: ScriptShape): string {
  const { containerCounts, sigCount, timelockCount, depth, maxBreadth } = shape;
  const parts: string[] = [];
  const containers = containerCounts.all + containerCounts.any + containerCounts.atLeast;
  if (containers === 0) {
    parts.push(sigCount > 0 ? 'a single signature' : 'a single timelock');
  } else {
    const kinds: string[] = [];
    if (containerCounts.all > 0) kinds.push(`${formatCount(containerCounts.all)} all`);
    if (containerCounts.any > 0) kinds.push(`${formatCount(containerCounts.any)} any`);
    if (containerCounts.atLeast > 0) kinds.push(`${formatCount(containerCounts.atLeast)} atLeast`);
    parts.push(`${kinds.join(', ')} ${plural(containers, 'container')}`);
    parts.push(`${formatCount(sigCount)} ${plural(sigCount, 'signature')}`);
    if (timelockCount > 0)
      parts.push(`${formatCount(timelockCount)} ${plural(timelockCount, 'timelock')}`);
    parts.push(`depth ${formatCount(depth)}`);
    parts.push(`widest list ${formatCount(maxBreadth)}`);
  }
  return parts.join(', ');
}

/** The vector's own generator parameters, so a reader can match it against the family's question. */
function describeParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return '';
  const pairs = entries.map(
    ([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return `parameters ${pairs.join(', ')}`;
}

function describeVector(id: string, vector: VectorSummary | undefined): ScriptDescription {
  const href = `${REPO_BLOB}/vectors/${id}.json`;
  if (!vector) {
    return { id, summary: 'a corpus vector no longer in the current corpus', href };
  }
  const bits = [describeShape(vector.shape)];
  const params = describeParams(vector.params);
  if (params) bits.push(params);
  return { id, summary: bits.join('; '), href };
}

function describeObserved(id: string, script: ObservedScriptRecord | undefined): ScriptDescription {
  const href = `${REPO_BLOB}/chain-evidence/scripts.json`;
  if (!script) {
    return { id, summary: 'a script no longer in the observed set', href };
  }
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
  if (script.vectorId) bits.push(`the same bytes as corpus vector ${script.vectorId}`);
  const carriers = script.carriedBy.map((c) => ({
    network: c.network,
    txHash: c.txHash,
    location: c.location,
    href: explorerTxUrl(c.network, c.txHash),
  }));
  return {
    id,
    summary: bits.join('; '),
    href,
    carriers,
    ...(script.decodeError === undefined ? {} : { note: script.decodeError }),
  };
}

/** Describes the script a result row is about, for whichever question the result answers. */
export function describeScript(
  data: SiteData,
  path: ConstructionPath,
  id: string,
): ScriptDescription {
  if (path === 'decode-onchain') {
    return describeObserved(
      id,
      data.observed.scripts.find((s) => s.scriptHash === id),
    );
  }
  return describeVector(id, data.vectors.get(id));
}

/** The identifier as a link, with a short hash for an observed script so a table cell stays readable. */
export function renderScriptId(description: ScriptDescription, path: ConstructionPath): string {
  const label = path === 'decode-onchain' ? description.id.slice(0, 12) : description.id;
  const title = path === 'decode-onchain' ? ` title="${escapeAttr(description.id)}"` : '';
  return `<a class="mono" href="${escapeAttr(description.href)}"${title}>${escapeHtml(label)}</a>`;
}

/** The transactions an observed script was seen in, as links a reader can check. */
export function renderCarriers(description: ScriptDescription, root: string): string {
  if (!description.carriers || description.carriers.length === 0) return '';
  const links = description.carriers.map((c) => {
    const short = `<span class="mono">${escapeHtml(c.txHash.slice(0, 12))}</span>`;
    const anchor = `${root}chain-evidence.html#tx-${escapeAttr(c.txHash)}`;
    return `<a href="${anchor}" title="${escapeAttr(c.txHash)}">${short}</a> (${escapeHtml(c.location)})`;
  });
  const noun = plural(links.length, 'transaction');
  return `Accepted on ${escapeHtml(description.carriers[0]!.network)} in ${noun} ${links.join(', ')}.`;
}

/**
 * What the tool's wrong hash means, from which framing it corresponds to. A
 * hash the other framing produces is a re-encoding; one neither produces is
 * a hash nothing this project knows of would compute.
 */
export function explainDivergence(vector: VectorResult, path: ConstructionPath): string {
  switch (vector.matchedFraming) {
    case 'definite':
      return path === 'construct'
        ? 'The hash is the definite-length encoding of a different script.'
        : 'This is the hash of the same script re-encoded with definite-length lists everywhere. The bytes handed over carried an indefinite-length list, so the chain does not have this hash.';
    case 'cardanoBinary':
      return path === 'construct'
        ? 'The hash is the Haskell-rule encoding of a different script.'
        : 'This is the hash of the same script re-encoded with the Haskell rule, an indefinite-length list from 24 items. The bytes handed over carried a definite-length list, so the chain does not have this hash.';
    case 'both':
      return 'The hash matches both framings of a different script.';
    default:
      return 'Neither framing of this script produces this hash, so the tool built or read a different script from the one it was given.';
  }
}
