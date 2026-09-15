import { blake2b224 } from '../encode/script.js';
import { toHex } from '../encode/cbor.js';

/**
 * Deterministic stand-in key hashes for generated scripts.
 *
 * A vector's script hash has to reproduce byte for byte in every language that
 * implements the spec, so the key hashes inside it cannot come from a random
 * wallet. They are derived from a label: hash the UTF-8 bytes of
 * `arachne/cosigner/<label>` and take the 28-byte digest. Any implementation
 * can regenerate them from the label alone, with no key material and no wallet.
 *
 * These are NOT keys. Nothing can sign for them, and no private key exists.
 * They are for offline encoding and satisfaction vectors only. A chain exercise
 * needs real signing keys and gets them from ARACHNE_COSIGNER_SEED; those
 * vectors record the key hashes that were actually used.
 */
const DOMAIN = 'arachne/cosigner/';

export function cosignerHash(label: string): string {
  return toHex(blake2b224(new TextEncoder().encode(DOMAIN + label)));
}

/** `cosigners(3)` gives the hashes for labels `c0`, `c1`, `c2`. */
export function cosigners(count: number, prefix = 'c'): string[] {
  return Array.from({ length: count }, (_, i) => cosignerHash(`${prefix}${i}`));
}
