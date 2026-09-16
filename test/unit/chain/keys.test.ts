import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  decodeSigningKeyEnvelope,
  loadSigningKeyFile,
  sign,
  signingKeyFromSeed,
  verify,
  SigningKeyEnvelopeError,
  type SigningKeyEnvelope,
} from '../../../src/chain/keys.js';
import { toHex } from '../../../src/encode/cbor.js';
import { CardanoCliOracle, cardanoCliAvailable } from './support/cardano-cli.js';

describe('signing key envelope', () => {
  it('unwraps a cardano-cli PaymentSigningKeyShelley envelope to its 32-byte seed', () => {
    // cardano-cli wraps the seed as a CBOR byte string: `0x58 0x20` (major
    // type 2, one-byte length form, length 32) then the 32 raw bytes.
    // Confirmed against real `cardano-cli address key-gen` output, since
    // cardano-cli's envelope format is not itself a published spec.
    const seed = new Uint8Array(32).fill(7);
    const envelope: SigningKeyEnvelope = {
      type: 'PaymentSigningKeyShelley_ed25519',
      description: 'Payment Signing Key',
      cborHex: `5820${toHex(seed)}`,
    };
    expect(decodeSigningKeyEnvelope(envelope)).toEqual(seed);
  });

  it('rejects an envelope of a different key type', () => {
    // A stake key or a DRep key uses the same CBOR shape, so only the `type`
    // string tells them apart. Silently accepting the wrong one would sign
    // with a key that satisfies a different credential than intended.
    const envelope: SigningKeyEnvelope = {
      type: 'StakeSigningKeyShelley_ed25519',
      cborHex: `5820${'00'.repeat(32)}`,
    };
    expect(() => decodeSigningKeyEnvelope(envelope)).toThrow(SigningKeyEnvelopeError);
  });

  it('rejects a cborHex whose header does not claim exactly 32 bytes', () => {
    // A 16-byte byte string (header 0x5810) is well-formed CBOR and valid
    // JSON, so this cannot be caught by parsing alone; the length has to be
    // checked explicitly.
    const envelope: SigningKeyEnvelope = {
      type: 'PaymentSigningKeyShelley_ed25519',
      cborHex: `5810${'00'.repeat(16)}`,
    };
    expect(() => decodeSigningKeyEnvelope(envelope)).toThrow(SigningKeyEnvelopeError);
  });

  it('rejects a seed of the wrong length even if it did not come from decodeSigningKeyEnvelope', () => {
    expect(() => signingKeyFromSeed(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe('signing', () => {
  it('produces a signature that verifies against the derived verification key', () => {
    const key = signingKeyFromSeed(randomBytes(32));
    const message = new TextEncoder().encode('arachne chain exercise');
    const signature = sign(key, message);
    expect(signature).toHaveLength(64);
    expect(verify(key.vkey, message, signature)).toBe(true);
  });

  it('rejects a signature against a different message', () => {
    const key = signingKeyFromSeed(randomBytes(32));
    const signature = sign(key, new TextEncoder().encode('message a'));
    expect(verify(key.vkey, new TextEncoder().encode('message b'), signature)).toBe(false);
  });

  it('rejects a signature checked against an unrelated verification key', () => {
    const signer = signingKeyFromSeed(randomBytes(32));
    const impostor = signingKeyFromSeed(randomBytes(32));
    const message = new TextEncoder().encode('arachne chain exercise');
    const signature = sign(signer, message);
    expect(verify(impostor.vkey, message, signature)).toBe(false);
  });
});

const cliAvailable = cardanoCliAvailable();
const describeCli = cliAvailable ? describe : describe.skip;
if (!cliAvailable) {
  console.warn('cardano-cli not on PATH, skipping the chain key cross-check tests');
}

describeCli('cross-checked against cardano-cli', () => {
  let oracle: CardanoCliOracle;

  beforeEach(() => {
    oracle = new CardanoCliOracle();
  });

  afterEach(() => {
    oracle.dispose();
  });

  it('derives the same verification key and key hash cardano-cli derives for a key it generated', () => {
    // A freshly generated, never-funded key: nothing here touches
    // `.secrets/funding.skey`.
    const generated = oracle.generateKey();
    const key = loadSigningKeyFile(generated.skeyPath);
    expect(toHex(key.vkey)).toBe(oracle.readVerificationKeyBytes(generated.vkeyPath));
    expect(key.keyHash).toBe(generated.keyHash);
  });
});
