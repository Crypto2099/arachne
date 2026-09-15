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

type WriteAction = { kind: 'node'; script: NativeScript } | { kind: 'close' };

/**
 * Iterative pre-order. `CborWriter` is a mutable byte sink, so writing a
 * script never needs a value handed back from a child, only the right order
 * to visit nodes in, but the array-close byte for an indefinite-length list
 * has to come after every one of that list's children. That "after the
 * children" obligation is the only reason this needs a stack at all: each
 * entry is either a node still to write or a literal closing action, pushed
 * so that popping them reproduces the same order the recursive version wrote
 * bytes in.
 */
function writeScript(writer: CborWriter, script: NativeScript, encoding: ArrayEncoding): void {
  const stack: WriteAction[] = [{ kind: 'node', script }];

  while (stack.length > 0) {
    const action = stack.pop() as WriteAction;
    if (action.kind === 'close') {
      writer.break();
      continue;
    }

    const node = action.script;
    switch (node.type) {
      case 'sig':
        writer.arrayHeader(2).uint(SCRIPT_TAG.sig).bytes(fromHex(node.keyHash));
        break;
      case 'all':
      case 'any': {
        writer.arrayHeader(2).uint(SCRIPT_TAG[node.type]);
        const indefinite = openList(writer, node.scripts.length, encoding);
        pushChildren(stack, node.scripts, indefinite);
        break;
      }
      case 'atLeast': {
        writer.arrayHeader(3).uint(SCRIPT_TAG.atLeast).int(node.required);
        const indefinite = openList(writer, node.scripts.length, encoding);
        pushChildren(stack, node.scripts, indefinite);
        break;
      }
      case 'after':
      case 'before':
        writer.arrayHeader(2).uint(SCRIPT_TAG[node.type]).uint(node.slot);
        break;
    }
  }
}

function pushChildren(stack: WriteAction[], children: NativeScript[], indefinite: boolean): void {
  // The closer is pushed first so it pops last, then children in reverse so
  // popping visits them left to right, exactly as `for (const child of ...)`
  // did.
  if (indefinite) stack.push({ kind: 'close' });
  for (let i = children.length - 1; i >= 0; i -= 1) {
    stack.push({ kind: 'node', script: children[i] as NativeScript });
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
  // Early-exit search, not a tree build, so a plain stack of nodes still to
  // visit is enough; visit order does not matter for an existence check.
  const stack: NativeScript[] = [script];
  while (stack.length > 0) {
    const node = stack.pop() as NativeScript;
    if (node.type !== 'all' && node.type !== 'any' && node.type !== 'atLeast') continue;
    if (node.scripts.length >= CARDANO_BINARY_INDEFINITE_THRESHOLD) return true;
    for (const child of node.scripts) stack.push(child);
  }
  return false;
}

export function blake2b224(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 28 });
}
