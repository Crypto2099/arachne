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

export function encodeScript(script: NativeScript): Uint8Array {
  const writer = new CborWriter();
  writeScript(writer, script);
  return writer.toBytes();
}

function writeScript(writer: CborWriter, script: NativeScript): void {
  switch (script.type) {
    case 'sig':
      writer.arrayHeader(2).uint(SCRIPT_TAG.sig).bytes(fromHex(script.keyHash));
      return;
    case 'all':
    case 'any':
      writer.arrayHeader(2).uint(SCRIPT_TAG[script.type]).arrayHeader(script.scripts.length);
      for (const child of script.scripts) writeScript(writer, child);
      return;
    case 'atLeast':
      writer
        .arrayHeader(3)
        .uint(SCRIPT_TAG.atLeast)
        .int(script.required)
        .arrayHeader(script.scripts.length);
      for (const child of script.scripts) writeScript(writer, child);
      return;
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
export function hashPreimage(script: NativeScript): Uint8Array {
  const body = encodeScript(script);
  const out = new Uint8Array(body.length + 1);
  out[0] = NATIVE_SCRIPT_LANGUAGE_TAG;
  out.set(body, 1);
  return out;
}

/** blake2b-224 of the prefixed CBOR, lowercase hex. This is the script hash. */
export function scriptHash(script: NativeScript): ScriptHash {
  return toHex(blake2b(hashPreimage(script), { dkLen: 28 }));
}

export function blake2b224(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 28 });
}
