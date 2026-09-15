import { blake2b } from '@noble/hashes/blake2b';
import { CborWriter, fromHex, toHex } from './cbor.js';
import type { NativeScript, ScriptHash } from '../model/types.js';

/**
 * The CBOR tag each script type carries, from the Conway CDDL:
 *
 *   script_pubkey      = (0, addr_keyhash)
 *   script_all         = (1, [* native_script])
 *   script_any         = (2, [* native_script])
 *   script_n_of_k      = (3, n : int64, [* native_script])
 *   invalid_before     = (4, slot_no)
 *   invalid_hereafter  = (5, slot_no)
 *
 * Note the inversion against the JSON names: JSON `after` is `invalid_before`
 * and JSON `before` is `invalid_hereafter`. Getting this backwards produces a
 * well-formed script with a valid hash that means the opposite of what was
 * intended, which no amount of structural validation will catch.
 */
export const SCRIPT_TAG = {
  sig: 0,
  all: 1,
  any: 2,
  atLeast: 3,
  after: 4,
  before: 5,
} as const satisfies Record<NativeScript['type'], number>;

/** Language tag prepended before hashing. Native scripts are language 0. */
export const NATIVE_SCRIPT_LANGUAGE_TAG = 0x00;

/**
 * How a sub-script list is framed. The two encodings produce DIFFERENT script
 * hashes, and therefore different addresses and governance identifiers, for the
 * same logical script.
 *
 * `definite` writes every list as a shortest-form definite-length array. This is
 * what cardano-serialization-lib, MeshJS and most of the JavaScript ecosystem
 * produce.
 *
 * `cardanoBinary` reproduces `wrapCBORArray` in `cardano-binary`: a definite
 * length up to 23 elements, and an indefinite-length array closed by `break`
 * from 24 elements up. This is what cardano-cli and cardano-node produce.
 *
 * Below 24 children the two are byte-identical, which is why almost every real
 * script is unaffected and why the divergence goes unnoticed. See
 * spec/07-encoding-divergence.md.
 */
export type ArrayEncoding = 'definite' | 'cardanoBinary';

/** The element count at which `cardano-binary` switches to indefinite framing. */
export const CARDANO_BINARY_INDEFINITE_THRESHOLD = 24;

export function encodeScript(
  script: NativeScript,
  encoding: ArrayEncoding = 'definite',
): Uint8Array {
  const writer = new CborWriter();
  writeScript(writer, script, encoding);
  return writer.toBytes();
}

function openList(writer: CborWriter, length: number, encoding: ArrayEncoding): boolean {
  if (encoding === 'cardanoBinary' && length >= CARDANO_BINARY_INDEFINITE_THRESHOLD) {
    writer.arrayHeaderIndefinite();
    return true;
  }
  writer.arrayHeader(length);
  return false;
}

function writeScript(writer: CborWriter, script: NativeScript, encoding: ArrayEncoding): void {
  switch (script.type) {
    case 'sig':
      writer.arrayHeader(2).uint(SCRIPT_TAG.sig).bytes(fromHex(script.keyHash));
      return;
    case 'all':
    case 'any': {
      writer.arrayHeader(2).uint(SCRIPT_TAG[script.type]);
      const indefinite = openList(writer, script.scripts.length, encoding);
      for (const child of script.scripts) writeScript(writer, child, encoding);
      if (indefinite) writer.break();
      return;
    }
    case 'atLeast': {
      writer.arrayHeader(3).uint(SCRIPT_TAG.atLeast).int(script.required);
      const indefinite = openList(writer, script.scripts.length, encoding);
      for (const child of script.scripts) writeScript(writer, child, encoding);
      if (indefinite) writer.break();
      return;
    }
    case 'after':
    case 'before':
      writer.arrayHeader(2).uint(SCRIPT_TAG[script.type]).uint(script.slot);
      return;
  }
}

/**
 * The exact byte string the hash is taken over: the language tag followed by
 * the script's CBOR. Exposed separately because when a port's hash disagrees,
 * the first question is always whether the CBOR differs or only the prefix, and
 * comparing this answers it in one step.
 */
export function hashPreimage(
  script: NativeScript,
  encoding: ArrayEncoding = 'definite',
): Uint8Array {
  const body = encodeScript(script, encoding);
  const out = new Uint8Array(body.length + 1);
  out[0] = NATIVE_SCRIPT_LANGUAGE_TAG;
  out.set(body, 1);
  return out;
}

/**
 * blake2b-224 of the prefixed CBOR, lowercase hex.
 *
 * The encoding argument is load-bearing above 23 children. A caller that does
 * not know which toolchain produced a script should use `scriptHashes` and
 * check both rather than guessing.
 */
export function scriptHash(script: NativeScript, encoding: ArrayEncoding = 'definite'): ScriptHash {
  return toHex(blake2b(hashPreimage(script, encoding), { dkLen: 28 }));
}

export interface ScriptHashes {
  /** cardano-serialization-lib, MeshJS, most JavaScript tooling. */
  definite: ScriptHash;
  /** cardano-cli, cardano-node, Haskell tooling. */
  cardanoBinary: ScriptHash;
  /**
   * True when the two differ, which happens exactly when some container holds
   * 24 or more sub-scripts. A script with this flag set has two valid hashes,
   * two valid addresses and two valid governance identifiers, and which one the
   * chain holds depends on which tool created it.
   */
  encodingSensitive: boolean;
}

/** Both hashes plus whether they diverge. This is the safe way to ask. */
export function scriptHashes(script: NativeScript): ScriptHashes {
  const definite = scriptHash(script, 'definite');
  const cardanoBinary = scriptHash(script, 'cardanoBinary');
  return { definite, cardanoBinary, encodingSensitive: definite !== cardanoBinary };
}

/** Whether any container in the script holds enough children to diverge. */
export function isEncodingSensitive(script: NativeScript): boolean {
  if (script.type === 'all' || script.type === 'any' || script.type === 'atLeast') {
    if (script.scripts.length >= CARDANO_BINARY_INDEFINITE_THRESHOLD) return true;
    return script.scripts.some(isEncodingSensitive);
  }
  return false;
}

export function blake2b224(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 28 });
}
