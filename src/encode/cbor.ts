/**
 * A deterministic CBOR writer covering exactly the native script CDDL subset.
 *
 * Arachne hand-rolls this rather than delegating to a CBOR library because the
 * encoding is the thing under test. A port in another language has to reproduce
 * these bytes, so the rules have to be stated somewhere legible and small
 * enough to read in full. The whole grammar is unsigned integers, negative
 * integers, byte strings and arrays, all definite length, all shortest-form.
 * See spec/02-encoding.md.
 */

const MAJOR_UINT = 0 << 5;
const MAJOR_NINT = 1 << 5;
const MAJOR_BYTES = 2 << 5;
const MAJOR_ARRAY = 4 << 5;

export class CborWriter {
  private chunks: number[] = [];

  /** Head byte plus shortest-form argument. The only length rule in play. */
  private head(major: number, value: bigint): this {
    if (value < 0n) throw new RangeError('argument must be non-negative');
    if (value < 24n) {
      this.chunks.push(major | Number(value));
    } else if (value <= 0xffn) {
      this.chunks.push(major | 24, Number(value));
    } else if (value <= 0xffffn) {
      this.chunks.push(major | 25, Number(value >> 8n) & 0xff, Number(value) & 0xff);
    } else if (value <= 0xffffffffn) {
      this.chunks.push(major | 26);
      for (let shift = 24n; shift >= 0n; shift -= 8n) {
        this.chunks.push(Number((value >> shift) & 0xffn));
      }
    } else if (value <= 0xffffffffffffffffn) {
      this.chunks.push(major | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        this.chunks.push(Number((value >> shift) & 0xffn));
      }
    } else {
      throw new RangeError('argument exceeds 64 bits');
    }
    return this;
  }

  /** CDDL `uint`, and the positive half of `int64`. */
  uint(value: number | bigint): this {
    return this.head(MAJOR_UINT, BigInt(value));
  }

  /**
   * CDDL `nint`. Reachable only through `script_n_of_k`, whose `n` is `int64`
   * rather than `uint`, so a negative threshold is representable even though no
   * standard tool emits one. Encoded as -1 minus the argument, per RFC 8949.
   */
  nint(value: number | bigint): this {
    const v = BigInt(value);
    if (v >= 0n) throw new RangeError('nint requires a negative value');
    return this.head(MAJOR_NINT, -1n - v);
  }

  /** Either half of `int64`, dispatching on sign. */
  int(value: number | bigint): this {
    return BigInt(value) < 0n ? this.nint(value) : this.uint(value);
  }

  bytes(value: Uint8Array): this {
    this.head(MAJOR_BYTES, BigInt(value.length));
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  /** Definite-length array header. */
  arrayHeader(length: number): this {
    return this.head(MAJOR_ARRAY, BigInt(length));
  }

  /** Indefinite-length array header, closed by `break`. */
  arrayHeaderIndefinite(): this {
    this.chunks.push(MAJOR_ARRAY | 31);
    return this;
  }

  /** The `break` byte that terminates an indefinite-length array. */
  break(): this {
    this.chunks.push(0xff);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new RangeError('hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new RangeError(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
