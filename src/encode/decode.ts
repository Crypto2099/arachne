import { blake2b224, SCRIPT_TAG, type ArrayEncoding } from './script.js';
import { fromHex, toHex } from './cbor.js';
import type { NativeScript, ScriptHash } from '../model/types.js';

/**
 * CBOR to script. The other half of the encoder, and the half that matters for
 * interoperability: scripts arrive from the chain as bytes, not as JSON.
 *
 * Decoding alone is not enough. The same logical script has two valid CBOR
 * framings that hash differently, so anything that decodes and re-encodes can
 * silently change a script's hash, its address and its governance identifier.
 * `decodeScript` therefore reports which framings would reproduce the exact
 * bytes it read, and `scriptHashFromCbor` hashes the received bytes directly
 * rather than round-tripping. See spec/07-encoding-divergence.md.
 */

export class CborDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`offset ${offset}: ${message}`);
    this.name = 'CborDecodeError';
    this.offset = offset;
  }
}

class CborReader {
  private readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) {
      throw new CborDecodeError('unexpected end of input', this.offset);
    }
    return this.bytes[this.offset++] as number;
  }

  peek(): number {
    if (this.offset >= this.bytes.length) {
      throw new CborDecodeError('unexpected end of input', this.offset);
    }
    return this.bytes[this.offset] as number;
  }

  /** Head byte plus argument. Returns the major type and the argument. */
  private head(): { major: number; info: number; arg: bigint } {
    const at = this.offset;
    const head = this.byte();
    const major = head >> 5;
    const info = head & 0x1f;

    if (info < 24) return { major, info, arg: BigInt(info) };
    if (info === 31) return { major, info, arg: -1n }; // indefinite marker

    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) throw new CborDecodeError(`reserved additional info ${info}`, at);

    let arg = 0n;
    for (let i = 0; i < width; i += 1) arg = (arg << 8n) | BigInt(this.byte());
    return { major, info, arg };
  }

  uint(): bigint {
    const { major, arg, info } = this.head();
    if (major !== 0)
      throw new CborDecodeError(`expected an unsigned integer, got major ${major}`, this.offset);
    if (info === 31) throw new CborDecodeError('indefinite length is not an integer', this.offset);
    return arg;
  }

  /** CDDL `int64`: the positive and negative halves. */
  int(): bigint {
    const at = this.offset;
    const { major, arg, info } = this.head();
    if (info === 31) throw new CborDecodeError('indefinite length is not an integer', at);
    if (major === 0) return arg;
    if (major === 1) return -1n - arg;
    throw new CborDecodeError(`expected an integer, got major ${major}`, at);
  }

  bytes_(): Uint8Array {
    const at = this.offset;
    const { major, arg, info } = this.head();
    if (major !== 2) throw new CborDecodeError(`expected a byte string, got major ${major}`, at);
    if (info === 31)
      throw new CborDecodeError('indefinite-length byte strings are not used here', at);
    const length = Number(arg);
    const start = this.offset;
    this.offset += length;
    if (this.offset > this.bytes.length)
      throw new CborDecodeError('byte string runs past the end', at);
    return this.bytes.subarray(start, this.offset);
  }

  /** Array header. `length` is null when the array is indefinite. */
  arrayHeader(): { length: number | null } {
    const at = this.offset;
    const { major, arg, info } = this.head();
    if (major !== 4) throw new CborDecodeError(`expected an array, got major ${major}`, at);
    return { length: info === 31 ? null : Number(arg) };
  }

  atBreak(): boolean {
    return !this.done && this.peek() === 0xff;
  }

  readBreak(): void {
    const at = this.offset;
    if (this.byte() !== 0xff) throw new CborDecodeError('expected a break', at);
  }
}

/** One sub-script list as it appeared on the wire. */
interface ListFraming {
  length: number;
  indefinite: boolean;
}

export interface DecodedScript {
  script: NativeScript;
  /**
   * Which encodings would reproduce the exact bytes decoded.
   *
   * Both when every sub-script list holds fewer than 24 entries, since the two
   * agree there. Exactly one when some list crosses the boundary. EMPTY when the
   * bytes match neither profile, which means a producer framed a list in a way
   * no standard encoder does. Re-encoding such a script changes its hash, so its
   * hash can only be taken over the original bytes.
   */
  framings: ArrayEncoding[];
  /** True when the two standard encodings would give this script different hashes. */
  encodingSensitive: boolean;
  /** Bytes consumed. Trailing data is reported rather than ignored. */
  bytesRead: number;
}

export function decodeScript(input: Uint8Array | string): DecodedScript {
  const bytes = typeof input === 'string' ? fromHex(input) : input;
  const reader = new CborReader(bytes);
  const lists: ListFraming[] = [];
  const script = readScript(reader, lists);

  if (!reader.done) {
    throw new CborDecodeError(`${bytes.length - reader.offset} trailing bytes`, reader.offset);
  }

  const framings: ArrayEncoding[] = [];
  if (lists.every((l) => !l.indefinite)) framings.push('definite');
  if (lists.every((l) => l.indefinite === l.length >= 24)) framings.push('cardanoBinary');

  return {
    script,
    framings,
    encodingSensitive: lists.some((l) => l.length >= 24),
    bytesRead: reader.offset,
  };
}

/** One script node's own fields, read up to but not into its `scripts` list. */
type NodeHead =
  | { leaf: true; script: NativeScript }
  | { leaf: false; type: 'all' | 'any'; indefinite: boolean; length: number | null }
  | { leaf: false; type: 'atLeast'; required: number; indefinite: boolean; length: number | null };

function readNodeHead(reader: CborReader): NodeHead {
  const at = reader.offset;
  const { length } = reader.arrayHeader();
  if (length === null) throw new CborDecodeError('a script node is a definite-length array', at);
  if (length !== 2 && length !== 3) {
    throw new CborDecodeError(`a script node has 2 or 3 elements, got ${length}`, at);
  }

  const tag = Number(reader.uint());
  switch (tag) {
    case SCRIPT_TAG.sig: {
      const hash = reader.bytes_();
      if (hash.length !== 28) {
        throw new CborDecodeError(`a key hash is 28 bytes, got ${hash.length}`, at);
      }
      return { leaf: true, script: { type: 'sig', keyHash: toHex(hash) } };
    }
    case SCRIPT_TAG.all:
    case SCRIPT_TAG.any: {
      const list = readListHead(reader);
      return { leaf: false, type: tag === SCRIPT_TAG.all ? 'all' : 'any', ...list };
    }
    case SCRIPT_TAG.atLeast: {
      const required = Number(reader.int());
      const list = readListHead(reader);
      return { leaf: false, type: 'atLeast', required, ...list };
    }
    case SCRIPT_TAG.after:
      return { leaf: true, script: { type: 'after', slot: Number(reader.uint()) } };
    case SCRIPT_TAG.before:
      return { leaf: true, script: { type: 'before', slot: Number(reader.uint()) } };
    default:
      throw new CborDecodeError(`unknown script tag ${tag}`, at);
  }
}

function readListHead(reader: CborReader): { length: number | null; indefinite: boolean } {
  const { length } = reader.arrayHeader();
  return { length, indefinite: length === null };
}

/** One open container's `scripts` list, read one child at a time. */
type ReadFrame =
  | { type: 'all' | 'any'; indefinite: boolean; length: number | null; children: NativeScript[] }
  | {
      type: 'atLeast';
      required: number;
      indefinite: boolean;
      length: number | null;
      children: NativeScript[];
    };

/**
 * Iterative post-order over the CBOR bytes themselves, not just the tree they
 * describe: a container's `NativeScript` cannot be built until every child
 * has been decoded, but its list framing (definite or indefinite, and how
 * many children) is read from the byte stream before any child is, so the
 * work stack here doubles as the parser's position in that stream. Each
 * frame is one open container; `listDone` both asks and, for an
 * indefinite-length list, consumes the `break` byte that answers it, exactly
 * where `while (!reader.atBreak())` used to.
 */
function readScript(reader: CborReader, lists: ListFraming[]): NativeScript {
  const stack: ReadFrame[] = [];
  let pending: undefined | true = true; // whether the next step reads a fresh node
  let completed: NativeScript | undefined;

  const listDone = (frame: ReadFrame): boolean => {
    if (frame.indefinite) {
      if (!reader.atBreak()) return false;
      reader.readBreak();
      return true;
    }
    return frame.children.length === frame.length;
  };

  const finish = (frame: ReadFrame): NativeScript => {
    lists.push({ length: frame.children.length, indefinite: frame.indefinite });
    return frame.type === 'atLeast'
      ? { type: 'atLeast', required: frame.required, scripts: frame.children }
      : { type: frame.type, scripts: frame.children };
  };

  while (pending !== undefined || stack.length > 0) {
    if (pending !== undefined) {
      pending = undefined;
      const head = readNodeHead(reader);
      if (head.leaf) {
        completed = head.script;
      } else {
        const frame: ReadFrame =
          head.type === 'atLeast'
            ? {
                type: 'atLeast',
                required: head.required,
                indefinite: head.indefinite,
                length: head.length,
                children: [],
              }
            : { type: head.type, indefinite: head.indefinite, length: head.length, children: [] };
        if (listDone(frame)) {
          completed = finish(frame);
        } else {
          stack.push(frame);
          pending = true; // read the first child next
        }
      }
      continue;
    }

    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    frame.children.push(completed as NativeScript);
    completed = undefined;

    if (listDone(frame)) {
      stack.pop();
      completed = finish(frame);
    } else {
      pending = true; // read the next sibling
    }
  }

  return completed as NativeScript;
}

/**
 * The script hash of CBOR exactly as received.
 *
 * This is the safe primitive when a script arrives from the chain or from
 * another tool. Decoding and re-encoding can change the framing and therefore
 * the hash; hashing the received bytes cannot. It is also what the ledger does,
 * which retains the original bytes for hashing.
 */
export function scriptHashFromCbor(input: Uint8Array | string): ScriptHash {
  const body = typeof input === 'string' ? fromHex(input) : input;
  const preimage = new Uint8Array(body.length + 1);
  preimage[0] = 0x00;
  preimage.set(body, 1);
  return toHex(blake2b224(preimage));
}
