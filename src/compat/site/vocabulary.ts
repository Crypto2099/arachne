import type { Framing, VectorStatus } from '../classify.js';
import type { Channel, ConstructionPath, EngineRelation } from '../types.js';

/**
 * The words the published site uses for the values the JSON records, in one
 * place so every page says the same thing for the same value.
 *
 * The JSON keeps its identifiers (`definite`, `cardanoBinary`,
 * `framing-preserving`, `construct`, `agreed`, and so on) because programs and
 * the result files depend on them. The site names what each one means
 * instead, because a reader who has not read this repository has no way to
 * know that `cardanoBinary` is a Haskell library rather than a property of
 * Cardano, or that `agreed` on the chain-script question means "returned the
 * hash the chain has". The mapping from page word to JSON value is printed
 * once, on the "How to read this site" page, so nothing is hidden by the
 * renaming.
 */

/** Short label for an encoder's framing rule, as a builder of scripts. */
export const FRAMING_LABEL: Record<Framing, string> = {
  definite: 'Definite-length lists at every size',
  cardanoBinary: 'Indefinite-length lists from 24 items',
  'framing-preserving': 'Keeps the bytes it was given',
  mixed: 'Inconsistent within one run',
  undetermined: 'Not determined by this run',
};

/** Shorter still, for a table cell. */
export const FRAMING_SHORT: Record<Framing, string> = {
  definite: 'Definite-length everywhere',
  cardanoBinary: 'Indefinite-length from 24',
  'framing-preserving': 'Keeps input bytes',
  mixed: 'Inconsistent',
  undetermined: 'Not determined',
};

/**
 * On the two questions that hand a tool bytes, `definite` and `cardanoBinary`
 * mean the tool re-encoded what it decoded and settled on that rule, which is
 * a different finding from producing that rule when building from scratch.
 */
export function framingLabel(framing: Framing, path: ConstructionPath): string {
  if (path === 'construct') return FRAMING_SHORT[framing];
  switch (framing) {
    case 'definite':
      return 'Re-encodes as definite-length';
    case 'cardanoBinary':
      return 'Re-encodes as indefinite from 24';
    default:
      return FRAMING_SHORT[framing];
  }
}

/** One sentence a reader can act on, for a tool that landed on this framing on this question. */
export function framingSentence(framing: Framing, path: ConstructionPath): string {
  if (path === 'construct') {
    switch (framing) {
      case 'definite':
        return 'Writes every list as a definite-length CBOR array, whatever its size. This is what most non-Haskell libraries do, and what a wallet-built script on chain almost always carries.';
      case 'cardanoBinary':
        return 'Writes a list of up to 23 items as a definite-length CBOR array and switches to an indefinite-length array from 24 items. This is the rule the Haskell implementations follow, so it is what cardano-node and cardano-cli produce.';
      case 'framing-preserving':
        return 'Reproduced whichever framing it was given rather than settling on one.';
      case 'mixed':
        return 'Matched both framings on different scripts in one run, so it is not following one rule.';
      case 'undetermined':
        return 'No script in this run had a list of 24 or more items, where the two framings differ, so the run does not say which rule the tool follows.';
    }
  }
  switch (framing) {
    case 'framing-preserving':
      return 'Hashes the bytes it was handed rather than re-encoding them, so it returns the hash the chain has whichever way the script was framed. This is the correct behaviour for a script that already exists.';
    case 'definite':
      return 'Decodes the bytes, re-encodes the script with definite-length lists everywhere, and hashes that. For a script the chain holds with an indefinite-length list, the hash it returns is one the chain does not have.';
    case 'cardanoBinary':
      return 'Decodes the bytes, re-encodes the script with the Haskell rule, and hashes that. For a script the chain holds with a definite-length list of 24 or more items, the hash it returns is one the chain does not have.';
    case 'mixed':
      return 'Matched both framings on different scripts in one run, so it is not following one rule.';
    case 'undetermined':
      return 'No script in this run distinguished the two framings, so the run does not say what the tool does with a list of 24 or more items.';
  }
}

/** CSS class suffix for a framing, so a stylesheet never has to spell `framing-preserving`. */
export function framingClass(framing: Framing): string {
  switch (framing) {
    case 'definite':
      return 'definite';
    case 'cardanoBinary':
      return 'indef';
    case 'framing-preserving':
      return 'keep';
    case 'mixed':
      return 'mixed';
    case 'undetermined':
      return 'undet';
  }
}

/** The three questions a tool is asked, in the order the site shows them. */
export const PATH_TITLE: Record<ConstructionPath, string> = {
  construct: 'Building scripts',
  decode: 'Round-tripping bytes',
  'decode-onchain': 'Reading chain scripts',
};

export const PATH_QUESTION: Record<ConstructionPath, string> = {
  construct:
    'Given the structure of a script, which bytes does the library produce, and does their hash match one of the two valid hashes?',
  decode:
    'Given valid script bytes in either framing, does the library return the hash of those bytes, or re-encode them first?',
  'decode-onchain':
    'Given the bytes of a script a real node has accepted, does the library return the hash the chain has?',
};

/** What "correct" means on each question, for the result page's summary line. */
export const PATH_CORRECT_MEANS: Record<ConstructionPath, string> = {
  construct: 'the hash matched one of the two valid hashes the corpus records for that script',
  decode: 'the hash matched one of the two valid hashes the corpus records for that script',
  'decode-onchain': 'the hash is the one those exact bytes have on chain',
};

export const OUTCOME_LABEL: Record<VectorStatus, string> = {
  agreed: 'correct',
  diverged: 'wrong hash',
  refused: 'refused',
  unsupported: 'cannot represent',
};

/** Section heading on a result page, for the scripts with that outcome. */
export const OUTCOME_HEADING: Record<VectorStatus, string> = {
  agreed: 'Correct',
  diverged: 'Wrong hash',
  refused: 'Refused',
  unsupported: 'Cannot represent',
};

export const OUTCOME_ORDER: readonly VectorStatus[] = [
  'diverged',
  'refused',
  'unsupported',
  'agreed',
];

export const CHANNEL_LABEL: Record<Channel, string> = {
  current: 'latest release',
  previous: 'previous release',
  beta: 'pre-release',
};

/** How a tool gets its bytes, as a phrase that follows the tool's name. */
export function relationPhrase(relation: EngineRelation, engineName: string): string {
  switch (relation) {
    case 'own':
      return 'its own encoder';
    case 'depends':
      return `uses ${engineName} as a dependency`;
    case 'fork':
      return `a fork of ${engineName}`;
    case 'vendored':
      return `carries a private copy of ${engineName}`;
    case 'reimplements':
      return `reimplements the ${engineName} rule independently`;
  }
}

/** "a", "a and b", "a, b and c": a list as a sentence would carry it. Items are already escaped. */
export function joinNames(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** `en-US` fixed, so the rendered bytes do not depend on the host locale. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** A machine timestamp as a date a person reads, keeping the full value for the `title`. */
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
