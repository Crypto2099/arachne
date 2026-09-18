import { readFile } from 'node:fs/promises';
import { DEFAULT_CORPUS_DIR, loadAllVectors, loadIndex } from '../vectors/load.js';
import type { Vector } from '../vectors/schema.js';
import { DEFAULT_OBSERVED_SCRIPTS_PATH, type ObservedScriptsFile } from '../chain/observed.js';
import { decodeScript, scriptHashFromCbor } from '../encode/decode.js';
import { encodeScript, type ArrayEncoding } from '../encode/script.js';
import { toHex } from '../encode/cbor.js';

export interface CompatCorpus {
  vectors: Vector[];
  /** `vectors/index.json`'s own digest, recorded verbatim rather than recomputed. */
  digest: string;
  generator: string;
}

/**
 * The committed corpus, as the compat runner sees it: every vector on disk,
 * plus the digest already recorded in `vectors/index.json`. The digest is
 * read rather than recomputed so a result file always states the digest of
 * the corpus actually on disk when the tool ran, whatever produced it.
 */
export async function loadCompatCorpus(dir = DEFAULT_CORPUS_DIR): Promise<CompatCorpus> {
  const [vectors, index] = await Promise.all([loadAllVectors(dir), loadIndex(dir)]);
  if (vectors.length === 0) {
    throw new Error(`no vectors found under ${dir}. Run "npm run vectors:build" first.`);
  }
  return { vectors, digest: index.digest, generator: index.generator };
}

/**
 * One observed script as the `decode-onchain` path needs it: the bytes to hand
 * over, the hash those bytes actually have, and the hash each standard encoder
 * would produce from the script they decode to.
 *
 * The last two are what let a divergence be named rather than only detected. A
 * tool that returns `definiteHash` for bytes that were framed `cardanoBinary`
 * has not returned a random wrong answer; it has re-encoded the script it
 * decoded, and knowing which framing it normalized to is the finding. Both are
 * absent when this library cannot decode the bytes, because there is then no
 * script to re-encode from.
 */
export interface ObservedCase {
  /** The observed script hash, which is `chain-evidence/scripts.json`'s own key. */
  id: string;
  cborHex: string;
  /** Hash of the bytes as received, and the one correct answer on this path. */
  observedHash: string;
  definiteHash?: string;
  cardanoBinaryHash?: string;
  /** Which standard encoders reproduce these bytes. Empty when neither does. */
  framings: ArrayEncoding[];
  decodable: boolean;
}

export interface ObservedCorpus {
  cases: ObservedCase[];
  /** `chain-evidence/scripts.json`'s own digest, recorded verbatim rather than recomputed. */
  digest: string;
}

/**
 * The observed script set, as the compat runner sees it.
 *
 * `observedHash` is recomputed from the bytes rather than read from the file,
 * so a corrupted `scriptHash` field cannot make a tool look correct. The
 * digest is read rather than recomputed, matching `loadCompatCorpus`, so a
 * result always names the set that was actually on disk when the tool ran.
 */
export async function loadObservedCorpus(
  path = DEFAULT_OBSERVED_SCRIPTS_PATH,
): Promise<ObservedCorpus> {
  const file = JSON.parse(await readFile(path, 'utf8')) as ObservedScriptsFile;
  if (file.scripts.length === 0) {
    throw new Error(`no observed scripts found in ${path}. Run "npm run chain-evidence:scripts".`);
  }

  const cases = file.scripts.map((script): ObservedCase => {
    const observedHash = scriptHashFromCbor(script.cborHex);
    const base: ObservedCase = {
      id: observedHash,
      cborHex: script.cborHex,
      observedHash,
      framings: [...(script.framings ?? [])],
      decodable: script.decodable,
    };
    if (!script.decodable) return base;

    const decoded = decodeScript(script.cborHex);
    return {
      ...base,
      definiteHash: scriptHashFromCbor(toHex(encodeScript(decoded.script, 'definite'))),
      cardanoBinaryHash: scriptHashFromCbor(toHex(encodeScript(decoded.script, 'cardanoBinary'))),
    };
  });

  return { cases, digest: file.digest };
}
