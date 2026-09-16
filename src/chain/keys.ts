import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { fromHex, toHex } from '../encode/cbor.js';
import { blake2b224 } from '../encode/script.js';
import type { KeyHash } from '../model/types.js';

/**
 * ed25519 signing keys for chain exercises: loading a cardano-cli signing key
 * envelope, deriving the matching verification key and key hash, and signing
 * a transaction id.
 *
 * Native scripts spend under plain ed25519, not the extended (BIP32-ed25519)
 * keys HD wallets use, so `@noble/curves/ed25519` is the whole of it: no
 * chain code, no derivation path, just RFC 8032 over a 32-byte seed. It sits
 * on `@noble/hashes`, already a dependency for blake2b, so this adds one
 * package rather than a second hashing stack.
 */

export interface SigningKey {
  /** The 32-byte ed25519 seed, exactly as cardano-cli stores it. */
  seed: Uint8Array;
  /** The 32-byte ed25519 verification key, derived from the seed. */
  vkey: Uint8Array;
  /** blake2b-224 of the verification key: CIP-19's `addr_keyhash`. */
  keyHash: KeyHash;
}

/** The `cborHex` payload's own type tag, read from the envelope. */
export interface SigningKeyEnvelope {
  type: string;
  description?: string;
  cborHex: string;
}

/**
 * cardano-cli writes a Shelley payment signing key as a `TextEnvelope` whose
 * `cborHex` is a CBOR byte string wrapping the raw 32-byte ed25519 seed: the
 * two-byte header `0x58 0x20` (major type 2, one-byte length form, length 32)
 * followed by the seed itself, 34 bytes in all. Confirmed against the actual
 * output of `cardano-cli address key-gen`, since cardano-cli's envelope
 * format has no separate published spec to cite; the tool's own output is the
 * source.
 */
const CBOR_BYTES_HEADER = 0x58;
const SEED_LENGTH = 32;

const ENVELOPE_TYPE_PREFIX = 'PaymentSigningKeyShelley';

export class SigningKeyEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyEnvelopeError';
  }
}

/** Unwrap a `PaymentSigningKeyShelley` envelope's `cborHex` to its 32-byte seed. */
export function decodeSigningKeyEnvelope(envelope: SigningKeyEnvelope): Uint8Array {
  if (!envelope.type.startsWith(ENVELOPE_TYPE_PREFIX)) {
    throw new SigningKeyEnvelopeError(
      `expected a ${ENVELOPE_TYPE_PREFIX} envelope, got type "${envelope.type}"`,
    );
  }
  const wrapped = fromHex(envelope.cborHex);
  if (
    wrapped.length !== SEED_LENGTH + 2 ||
    wrapped[0] !== CBOR_BYTES_HEADER ||
    wrapped[1] !== SEED_LENGTH
  ) {
    throw new SigningKeyEnvelopeError(
      `expected cborHex to be a CBOR byte string of ${SEED_LENGTH} bytes (0x5820...), got ${toHex(wrapped)}`,
    );
  }
  return wrapped.subarray(2);
}

/** Derive the verification key and key hash for a 32-byte ed25519 seed. */
export function signingKeyFromSeed(seed: Uint8Array): SigningKey {
  if (seed.length !== SEED_LENGTH) {
    throw new RangeError(`an ed25519 seed is ${SEED_LENGTH} bytes, got ${seed.length}`);
  }
  const vkey = ed25519.getPublicKey(seed);
  return { seed, vkey, keyHash: toHex(blake2b224(vkey)) };
}

/**
 * Read and parse a cardano-cli `PaymentSigningKeyShelley` envelope file.
 *
 * Never call this on `.secrets/funding.skey` from a test or a fixture: the
 * key it returns must not be logged, asserted against, or otherwise carried
 * into anything committed. This function itself only reads what it is
 * pointed at; keeping the funding key out of the repository is the caller's
 * obligation.
 */
export function loadSigningKeyFile(path: string): SigningKey {
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as SigningKeyEnvelope;
  return signingKeyFromSeed(decodeSigningKeyEnvelope(envelope));
}

/** Sign a message (in practice, a transaction id) with a loaded signing key. */
export function sign(key: SigningKey, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, key.seed);
}

/** Verify a signature against a bare 32-byte verification key. */
export function verify(vkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return ed25519.verify(signature, message, vkey);
}
