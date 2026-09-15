/**
 * The native script AST, in the JSON shape that `cardano-cli`, MeshJS and the
 * Ekklesia fixtures all already speak.
 *
 * The JSON tag names and the CDDL field names disagree, and the disagreement is
 * inverted, which is a standing source of bugs. `after` is CDDL `invalid_before`
 * (CBOR tag 4) and means the transaction may not be valid before this slot.
 * `before` is CDDL `invalid_hereafter` (CBOR tag 5). Read `after` as "valid only
 * after", not as "the invalid_before field". See spec/01-script-model.md.
 */

/** Lowercase hex of a blake2b-224 digest, 56 characters. */
export type KeyHash = string;

/** Lowercase hex of a blake2b-224 digest of a serialized script, 56 characters. */
export type ScriptHash = string;

export interface ScriptSig {
  type: 'sig';
  keyHash: KeyHash;
}

export interface ScriptAll {
  type: 'all';
  scripts: NativeScript[];
}

export interface ScriptAny {
  type: 'any';
  scripts: NativeScript[];
}

export interface ScriptAtLeast {
  type: 'atLeast';
  required: number;
  scripts: NativeScript[];
}

/** CDDL `invalid_before`, CBOR tag 4. Valid only at or after `slot`. */
export interface ScriptAfter {
  type: 'after';
  slot: number;
}

/** CDDL `invalid_hereafter`, CBOR tag 5. Valid only strictly before `slot`. */
export interface ScriptBefore {
  type: 'before';
  slot: number;
}

export type NativeScript =
  ScriptSig | ScriptAll | ScriptAny | ScriptAtLeast | ScriptAfter | ScriptBefore;

export type NativeScriptType = NativeScript['type'];

/** The three tags that carry children. */
export type ScriptContainer = ScriptAll | ScriptAny | ScriptAtLeast;

export function isContainer(script: NativeScript): script is ScriptContainer {
  return script.type === 'all' || script.type === 'any' || script.type === 'atLeast';
}

export function isTimelock(script: NativeScript): script is ScriptAfter | ScriptBefore {
  return script.type === 'after' || script.type === 'before';
}
