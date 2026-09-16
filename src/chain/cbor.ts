/**
 * Minimal CBOR primitives for assembling a transaction body and witness set
 * around bytes the caller controls exactly.
 *
 * `src/encode/cbor.ts` covers exactly the native script CDDL subset: unsigned
 * and negative integers, byte strings, and definite or indefinite-length
 * arrays. A transaction needs two things that grammar has no use for: CBOR
 * maps (major type 5), for `transaction_body` and `transaction_witness_set`,
 * both keyed by small integers, and CBOR tag 258, for the CDDL's several
 * `set<a0>` fields. It also needs a way to splice bytes that are already
 * valid CBOR into a value being composed, unmodified, which is what carrying
 * a caller-supplied native script requires and which a writer built only to
 * emit its own encoding has no reason to expose.
 *
 * The shortest-form integer rule below is the same rule `src/encode/cbor.ts`
 * states, restated here rather than imported because that class's byte sink
 * is private and offers no way to append a raw, already-encoded value.
 */

const MAJOR_UINT = 0 << 5;
const MAJOR_BYTES = 2 << 5;
const MAJOR_ARRAY = 4 << 5;
const MAJOR_MAP = 5 << 5;
const MAJOR_TAG = 6 << 5;
const MAJOR_SIMPLE = 7 << 5;

/** RFC 8949 simple values used at the top of a transaction: `true` and `null`. */
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;

/**
 * The CDDL tag for `set<a0> = #6.258([* a0]) / [* a0]`.
 *
 * The grammar leaves the tag optional, so which form a node accepts is not
 * settled by reading it. Checked empirically instead: every `set`-typed field
 * `cardano-cli conway transaction build-raw` and `transaction sign` emit
 * (transaction inputs, vkey witnesses, native scripts) carries this tag, at
 * every size including one. `writeSet` below reproduces that.
 */
export const SET_TAG = 258;

export class TxCborWriter {
  private readonly chunks: Uint8Array[] = [];

  /** Head byte plus shortest-form argument, the only length rule in play. */
  private head(major: number, value: bigint): this {
    if (value < 0n) throw new RangeError('argument must be non-negative');
    let bytes: number[];
    if (value < 24n) {
      bytes = [major | Number(value)];
    } else if (value <= 0xffn) {
      bytes = [major | 24, Number(value)];
    } else if (value <= 0xffffn) {
      bytes = [major | 25, Number(value >> 8n) & 0xff, Number(value) & 0xff];
    } else if (value <= 0xffffffffn) {
      bytes = [major | 26];
      for (let shift = 24n; shift >= 0n; shift -= 8n) {
        bytes.push(Number((value >> shift) & 0xffn));
      }
    } else if (value <= 0xffffffffffffffffn) {
      bytes = [major | 27];
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        bytes.push(Number((value >> shift) & 0xffn));
      }
    } else {
      throw new RangeError('argument exceeds 64 bits');
    }
    this.chunks.push(Uint8Array.from(bytes));
    return this;
  }

  /** CDDL `uint`, and the positive half of a transaction's `int64` fields. */
  uint(value: number | bigint): this {
    return this.head(MAJOR_UINT, BigInt(value));
  }

  bytes(value: Uint8Array): this {
    this.head(MAJOR_BYTES, BigInt(value.length));
    this.chunks.push(value);
    return this;
  }

  /** Definite-length array header. Nothing at the transaction level is indefinite. */
  arrayHeader(length: number): this {
    return this.head(MAJOR_ARRAY, BigInt(length));
  }

  /** Definite-length map header, for `transaction_body` and `transaction_witness_set`. */
  mapHeader(length: number): this {
    return this.head(MAJOR_MAP, BigInt(length));
  }

  /** A CBOR tag. Used only for `#6.258`, the `set` wrapper. */
  tag(value: number): this {
    return this.head(MAJOR_TAG, BigInt(value));
  }

  /** RFC 8949 `true`, the transaction-level `is_valid` flag. */
  true(): this {
    return this.head(MAJOR_SIMPLE, BigInt(SIMPLE_TRUE));
  }

  /** RFC 8949 `null`, the transaction-level `auxiliary_data` when there is none. */
  null(): this {
    return this.head(MAJOR_SIMPLE, BigInt(SIMPLE_NULL));
  }

  /**
   * Splice bytes that are already valid CBOR, completely unmodified.
   *
   * This is the primitive the whole builder exists for: a native script enters
   * the witness set exactly as the caller encoded it, byte for byte, whether
   * that is `encodeScript(script, 'definite')`, `encodeScript(script,
   * 'cardanoBinary')`, or bytes from anywhere else. Nothing here decodes or
   * re-encodes them.
   */
  raw(value: Uint8Array): this {
    this.chunks.push(value);
    return this;
  }

  toBytes(): Uint8Array {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/**
 * Write a `set<a0>`: tag 258, a definite-length array header, then each item
 * in order. `writeItem` writes exactly one item's own encoding.
 *
 * Never called with an empty `items`: every `set`-typed field in the CDDL
 * this builder touches is a `nonempty_set`, and the caller omits the map key
 * entirely rather than writing a tagged empty array. Enforced here so a bug
 * upstream fails loudly instead of producing a transaction a node accepts for
 * the wrong reason.
 */
export function writeSet<T>(
  writer: TxCborWriter,
  items: readonly T[],
  writeItem: (writer: TxCborWriter, item: T) => void,
): void {
  if (items.length === 0) {
    throw new RangeError('a set field is never written empty; omit the map key instead');
  }
  writer.tag(SET_TAG).arrayHeader(items.length);
  for (const item of items) writeItem(writer, item);
}
