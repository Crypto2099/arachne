import { toHex } from '../encode/cbor.js';

/**
 * Finding the native scripts a real transaction carried, by offset, without
 * decoding them.
 *
 * `src/chain/cbor.ts` writes transaction CBOR; this reads it, and reads it in
 * the one way that preserves what is under test. A script's hash is taken over
 * the bytes exactly as they arrived, so anything that decodes a transaction
 * into objects and re-encodes the script it found can change the array framing
 * and therefore the hash, which is the divergence this whole project is about
 * (`spec/07-encoding-divergence.md`). Everything below therefore returns a
 * slice of the caller's buffer rather than a value rebuilt from it.
 *
 * The grammar walked here is quoted from `eras/conway/impl/cddl/data/conway.cddl`
 * in `IntersectMBO/cardano-ledger`:
 *
 *     transaction = [transaction_body, transaction_witness_set, bool, auxiliary_data/ nil]
 *     transaction_body = { 0 : set<transaction_input>, 1 : [* transaction_output], ... }
 *     transaction_witness_set = { ..., ? 1 : nonempty_list<native_script>, ... }
 *     nonempty_list<a0> = #6.258([+ a0])/ [+ a0]
 *     transaction_output = alonzo_transaction_output/ babbage_transaction_output
 *     alonzo_transaction_output = [address, amount : value, ? datum_hash : hash32]
 *     babbage_transaction_output = { 0 : address, 1 : value, ? 2 : datum_option, ? 3 : script_ref }
 *     script_ref = #6.24(bytes .cbor script)
 *     script = [ 0, native_script // 1, plutus_v1_script // 2, plutus_v2_script // 3, plutus_v3_script ]
 *
 * Two of those lines are why this reader is not a few obvious cases. Tag 258 is
 * optional in `nonempty_list`, so a witness set's script list is a bare array
 * in some transactions and a tagged one in others, and both are conforming;
 * reading the tag's header as the array's header yields a list of 258 items.
 * And `transaction_output` is a choice between an array and a map, so an output
 * has to be told apart by its major type before any field can be looked up.
 */
export class TransactionReadError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`offset ${offset}: ${message}`);
    this.name = 'TransactionReadError';
    this.offset = offset;
  }
}

/**
 * Where in a transaction a script's bytes were carried. The three are
 * genuinely different provenance, not three names for one thing:
 *
 * - `witness`, supplied inline to satisfy a spend in this same transaction;
 * - `output`, published into one of this transaction's own outputs as a
 *   `script_ref`, so a later transaction can spend against it without
 *   carrying it;
 * - `reference`, read out of an output an earlier transaction created and
 *   this one names as a reference input, which is the only case where the
 *   bytes are not in the transaction being read at all.
 */
export type ScriptLocation = 'witness' | 'output' | 'reference';

export interface ObservedScript {
  location: ScriptLocation;
  /** The script's CBOR exactly as the transaction carried it, lowercase hex. */
  cborHex: string;
}

interface Head {
  majorType: number;
  infoBits: number;
  /** The argument, already widened. Only read for types whose argument is a count or length. */
  value: number;
  /** Offset just past the head. */
  next: number;
}

function readHead(tx: Uint8Array, offset: number): Head {
  if (offset >= tx.length) throw new TransactionReadError('ran past the end of the buffer', offset);
  const initial = tx[offset]!;
  const majorType = initial >> 5;
  const infoBits = initial & 0x1f;
  let pos = offset + 1;
  let value = infoBits;

  const need = (n: number): void => {
    if (pos + n > tx.length) throw new TransactionReadError('truncated argument', offset);
  };

  if (infoBits === 24) {
    need(1);
    value = tx[pos]!;
    pos += 1;
  } else if (infoBits === 25) {
    need(2);
    value = (tx[pos]! << 8) | tx[pos + 1]!;
    pos += 2;
  } else if (infoBits === 26) {
    need(4);
    value = tx[pos]! * 0x1000000 + ((tx[pos + 1]! << 16) | (tx[pos + 2]! << 8) | tx[pos + 3]!);
    pos += 4;
  } else if (infoBits === 27) {
    // A transaction never needs a count or length above 2^53, and every
    // 64-bit argument this walk meets is a coin or a slot it only skips
    // over, so widening to a Number here loses nothing it goes on to use.
    need(8);
    let big = 0n;
    for (let i = 0; i < 8; i += 1) big = (big << 8n) | BigInt(tx[pos + i]!);
    value = Number(big);
    pos += 8;
  } else if (infoBits > 27 && infoBits !== 31) {
    throw new TransactionReadError(`reserved additional information ${infoBits}`, offset);
  }

  return { majorType, infoBits, value, next: pos };
}

/** An indefinite-length container, which ends at a break byte rather than after a known count. */
const BREAK = Symbol('break');

/**
 * The offset just past the item starting at `offset`, without building
 * anything from it.
 *
 * An explicit work stack stands in for the call stack, so this survives the
 * 5,383-wrapper script a node has already accepted on preprod, which is deep
 * enough to overflow a recursive walk. Every tree walk in this library is
 * iterative for the same reason; see the depth discussion in `CLAUDE.md` and
 * `test/unit/deep-nesting.test.ts`.
 */
export function skipItem(tx: Uint8Array, offset: number): number {
  let pos = offset;
  const stack: (number | typeof BREAK)[] = [1];

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top === BREAK) {
      if (pos >= tx.length) throw new TransactionReadError('unterminated indefinite item', offset);
      if (tx[pos] === 0xff) {
        pos += 1;
        stack.pop();
        continue;
      }
    } else if (top === 0) {
      stack.pop();
      continue;
    } else {
      stack[stack.length - 1] = top - 1;
    }

    const head = readHead(tx, pos);
    pos = head.next;

    switch (head.majorType) {
      case 0:
      case 1:
      case 7:
        break;
      case 2:
      case 3:
        if (head.infoBits === 31) stack.push(BREAK);
        else pos += head.value;
        break;
      case 4:
        stack.push(head.infoBits === 31 ? BREAK : head.value);
        break;
      case 5:
        // A map's argument counts pairs, so twice that many items follow.
        stack.push(head.infoBits === 31 ? BREAK : head.value * 2);
        break;
      case 6:
        stack.push(1);
        break;
      default:
        throw new TransactionReadError(`unsupported major type ${head.majorType}`, pos - 1);
    }
  }

  if (pos > tx.length)
    throw new TransactionReadError('item runs past the end of the buffer', offset);
  return pos;
}

/**
 * The `transaction_body` bytes: the first element of the outer array.
 *
 * Returned as a slice rather than re-encoded because this is what the
 * transaction id is taken over. `transactionId` in `src/chain/transaction.ts`
 * hashes it, so a stored transaction proves its own hash offline.
 */
export function transactionBodyBytes(tx: Uint8Array): Uint8Array {
  const outer = readHead(tx, 0);
  if (outer.majorType !== 4) {
    throw new TransactionReadError(`transaction is not an array, major type ${outer.majorType}`, 0);
  }
  return tx.subarray(outer.next, skipItem(tx, outer.next));
}

/** Steps past a tag, if one is present, and returns the offset of the value it wraps. */
function pastTag(tx: Uint8Array, offset: number): number {
  const head = readHead(tx, offset);
  return head.majorType === 6 ? head.next : offset;
}

/**
 * Walks a CBOR map's entries, calling `onEntry` with the key's head and the
 * offset of its value, and returns the offset just past the map.
 */
function eachMapEntry(
  tx: Uint8Array,
  offset: number,
  onEntry: (key: Head, valueOffset: number) => void,
): number {
  const head = readHead(tx, offset);
  if (head.majorType !== 5) throw new TransactionReadError('expected a map', offset);
  let pos = head.next;
  const indefinite = head.infoBits === 31;
  const count = indefinite ? Infinity : head.value;

  for (let i = 0; i < count; i += 1) {
    if (indefinite) {
      if (pos >= tx.length) throw new TransactionReadError('unterminated map', offset);
      if (tx[pos] === 0xff) {
        pos += 1;
        break;
      }
    }
    const key = readHead(tx, pos);
    const valueOffset = skipItem(tx, pos);
    onEntry(key, valueOffset);
    pos = skipItem(tx, valueOffset);
  }
  return pos;
}

/** The items of an array, as `[start, end]` offset pairs, unwrapping a set tag if present. */
function arrayItems(tx: Uint8Array, offset: number): [number, number][] {
  let pos = pastTag(tx, offset);
  const head = readHead(tx, pos);
  if (head.majorType !== 4) throw new TransactionReadError('expected an array', pos);
  pos = head.next;
  const indefinite = head.infoBits === 31;
  const count = indefinite ? Infinity : head.value;

  const items: [number, number][] = [];
  for (let i = 0; i < count; i += 1) {
    if (indefinite) {
      if (pos >= tx.length) throw new TransactionReadError('unterminated array', offset);
      if (tx[pos] === 0xff) break;
    }
    const end = skipItem(tx, pos);
    items.push([pos, end]);
    pos = end;
  }
  return items;
}

/**
 * The native scripts carried in a transaction's witness set, in order, as the
 * exact bytes the transaction carried.
 *
 * Returns an empty array when the witness set has no key 1, which is the
 * ordinary case for a transaction that spends from a reference script rather
 * than supplying one inline.
 */
export function witnessNativeScripts(tx: Uint8Array): string[] {
  const outer = readHead(tx, 0);
  const witnessOffset = skipItem(tx, outer.next);

  let listOffset: number | undefined;
  eachMapEntry(tx, witnessOffset, (key, valueOffset) => {
    if (key.majorType === 0 && key.value === 1) listOffset = valueOffset;
  });
  if (listOffset === undefined) return [];

  return arrayItems(tx, listOffset).map(([start, end]) => toHex(tx.subarray(start, end)));
}

/** The `[start, end]` offsets of each `transaction_output` in the body. */
function outputExtents(tx: Uint8Array): [number, number][] {
  const outer = readHead(tx, 0);
  const bodyOffset = outer.next;

  let outputsOffset: number | undefined;
  eachMapEntry(tx, bodyOffset, (key, valueOffset) => {
    if (key.majorType === 0 && key.value === 1) outputsOffset = valueOffset;
  });
  if (outputsOffset === undefined)
    throw new TransactionReadError('body has no outputs', bodyOffset);
  return arrayItems(tx, outputsOffset);
}

/** The native script in one output's `script_ref`, or `undefined` when it holds none or holds a Plutus one. */
function scriptRefAt(tx: Uint8Array, output: [number, number]): string | undefined {
  // An `alonzo_transaction_output` is an array and has no script_ref field at
  // all; only a `babbage_transaction_output`, a map, can carry one.
  const start = pastTag(tx, output[0]);
  if (readHead(tx, start).majorType !== 5) return undefined;

  let refOffset: number | undefined;
  eachMapEntry(tx, start, (key, valueOffset) => {
    if (key.majorType === 0 && key.value === 3) refOffset = valueOffset;
  });
  if (refOffset === undefined) return undefined;

  // script_ref = #6.24(bytes .cbor script): a tag, then a byte string whose
  // contents are themselves CBOR, so the script sits one buffer down.
  const inner = readHead(tx, pastTag(tx, refOffset));
  if (inner.majorType !== 2) {
    throw new TransactionReadError('script_ref is not a byte string', refOffset);
  }
  const wrapped = tx.subarray(inner.next, inner.next + inner.value);

  // script = [0, native_script // 1, plutus_v1_script // ...]: tag 0 is native.
  const items = arrayItems(wrapped, 0);
  const tagged = items[0];
  if (!tagged) throw new TransactionReadError('script_ref holds an empty array', refOffset);
  const tag = readHead(wrapped, tagged[0]);
  if (tag.majorType !== 0 || tag.value !== 0) return undefined;

  const body = items[1];
  if (!body)
    throw new TransactionReadError('script_ref names a type but holds no script', refOffset);
  return toHex(wrapped.subarray(body[0], body[1]));
}

/**
 * The native script held in one output's `script_ref`, as the exact bytes it
 * was stored as, or `undefined` when that output carries no script or carries
 * a Plutus one.
 *
 * This is the only route to a script that a spending transaction never
 * contained: a reference input names an output by transaction id and index,
 * and the bytes live in whichever earlier transaction created it.
 */
export function referenceScriptIn(tx: Uint8Array, outputIndex: number): string | undefined {
  const outputs = outputExtents(tx);
  const output = outputs[outputIndex];
  if (!output) {
    throw new TransactionReadError(
      `output index ${outputIndex} is past the ${outputs.length} outputs this transaction has`,
      0,
    );
  }
  return scriptRefAt(tx, output);
}

/** Every native script this transaction publishes into its own outputs, with the index of the output holding it. */
export function outputNativeScripts(tx: Uint8Array): { outputIndex: number; cborHex: string }[] {
  const found: { outputIndex: number; cborHex: string }[] = [];
  outputExtents(tx).forEach((output, outputIndex) => {
    const cborHex = scriptRefAt(tx, output);
    if (cborHex) found.push({ outputIndex, cborHex });
  });
  return found;
}

/**
 * Every native script a transaction itself carries: inline in its witness set,
 * and published into its own outputs.
 *
 * A script this transaction only referenced is not here and cannot be, since
 * those bytes are in another transaction entirely; `referenceScriptIn` reads
 * that one.
 */
export function nativeScriptsIn(tx: Uint8Array): ObservedScript[] {
  return [
    ...witnessNativeScripts(tx).map((cborHex) => ({ location: 'witness' as const, cborHex })),
    ...outputNativeScripts(tx).map(({ cborHex }) => ({ location: 'output' as const, cborHex })),
  ];
}
