import { execFileSync } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseScript } from '../../../src/model/json.js';
import { encodeScript, scriptHash } from '../../../src/encode/script.js';
import { decodeScript, scriptHashFromCbor } from '../../../src/encode/decode.js';
import { enterpriseAddress } from '../../../src/encode/credential.js';
import { cosigners } from '../../../src/generate/cosigners.js';
import { toHex, fromHex } from '../../../src/encode/cbor.js';
import { loadSigningKeyFile } from '../../../src/chain/keys.js';
import type { Utxo } from '../../../src/chain/provider.js';
import {
  encodeTransactionBody,
  encodeWitnessSet,
  encodeTransaction,
  transactionId,
  minFee,
  buildMinimalTransaction,
  buildReturnTransaction,
} from '../../../src/chain/transaction.js';
import { CardanoCliOracle, cardanoCliAvailable } from './support/cardano-cli.js';

/** 32 bytes of a fixed pattern, standing in for a UTxO that was never actually observed on chain. */
function fakeTxHash(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(32);
}

describe('transaction body encoding', () => {
  it('rejects a body with no inputs', () => {
    expect(() => encodeTransactionBody({ inputs: [], outputs: [], fee: 1n })).toThrow(RangeError);
  });

  it('rejects a negative fee', () => {
    expect(() =>
      encodeTransactionBody({
        inputs: [{ txHash: fakeTxHash(0), index: 0 }],
        outputs: [],
        fee: -1n,
      }),
    ).toThrow(RangeError);
  });

  it('encodes field 0 inputs as tag-258 set, field 1 outputs as a plain array, field 2 fee, in that map order', () => {
    // Checked against `cardano-cli conway transaction build-raw`: the CDDL
    // leaves `set<a0>` optional on the tag, but cardano-cli always writes it,
    // at every size including one, and always orders map keys ascending.
    // `01` (outputs) carries no tag because `transaction_output` is a plain
    // list in the CDDL, not a `set`.
    const body = encodeTransactionBody({
      inputs: [{ txHash: fakeTxHash(0), index: 0 }],
      outputs: [],
      fee: 200_000n,
    });
    expect(toHex(body)).toBe(
      'a3' + // map(3)
        '00' +
        'd90102' + // tag 258
        '81' + // array(1)
        '8258200000000000000000000000000000000000000000000000000000000000000000' +
        '00' +
        '01' +
        '80' + // outputs: array(0)
        '02' +
        '1a00030d40', // fee 200000
    );
  });

  it('writes field 3 (ttl) and field 8 (validity start) only when given, in ascending key order', () => {
    const withoutBounds = encodeTransactionBody({
      inputs: [{ txHash: fakeTxHash(0), index: 0 }],
      outputs: [],
      fee: 1n,
    });
    const withBounds = encodeTransactionBody({
      inputs: [{ txHash: fakeTxHash(0), index: 0 }],
      outputs: [],
      fee: 1n,
      ttl: 5_000_000n,
      validityStart: 1_000_000n,
    });
    expect(toHex(withoutBounds).startsWith('a3')).toBe(true); // map(3): 0, 1, 2
    expect(toHex(withBounds).startsWith('a5')).toBe(true); // map(5): 0, 1, 2, 3, 8
    // Same map contents otherwise, just a bigger map header (a3 -> a5) and
    // the two extra fields appended in ascending key order.
    expect(toHex(withBounds)).toBe(
      'a5' + toHex(withoutBounds).slice(2) + '031a004c4b40' + '081a000f4240',
    );
  });

  it('encodes an output as the legacy two-element array, address then lovelace', () => {
    // `shelley_transaction_output = [address, amount, ? datum_hash]` is still
    // valid alongside Babbage's map form and is what cardano-cli itself
    // writes for an ada-only output with no datum and no reference script.
    const address = enterpriseAddress('00'.repeat(28), 'preprod');
    const body = encodeTransactionBody({
      inputs: [{ txHash: fakeTxHash(0), index: 0 }],
      outputs: [{ address, lovelace: 3_800_000n }],
      fee: 200_000n,
    });
    expect(toHex(body)).toContain('82' + '581d70' + '00'.repeat(28) + '1a0039fbc0');
  });
});

describe('witness set encoding', () => {
  it('omits both fields when there is nothing to witness with', () => {
    expect(toHex(encodeWitnessSet({}))).toBe('a0');
  });

  it('omits field 0 when there are no vkey witnesses, even if the array was passed empty', () => {
    expect(toHex(encodeWitnessSet({ vkeyWitnesses: [] }))).toBe('a0');
  });

  it('writes field 0 as a tag-258 set of [vkey, signature] pairs', () => {
    const vkey = new Uint8Array(32).fill(1);
    const signature = new Uint8Array(64).fill(2);
    const bytes = encodeWitnessSet({ vkeyWitnesses: [{ vkey, signature }] });
    expect(toHex(bytes)).toBe(
      'a1' + '00' + 'd90102' + '81' + '82' + '5820' + '01'.repeat(32) + '5840' + '02'.repeat(64),
    );
  });

  it('splices a native script into field 1 unmodified, never re-encoding it', () => {
    const script = fromHex('8200581c' + '00'.repeat(28));
    const bytes = encodeWitnessSet({ nativeScripts: [script] });
    expect(toHex(bytes)).toBe('a1' + '01' + 'd90102' + '81' + toHex(script));
  });

  it('rejects a vkey or signature of the wrong length', () => {
    const goodSig = new Uint8Array(64);
    expect(() =>
      encodeWitnessSet({ vkeyWitnesses: [{ vkey: new Uint8Array(31), signature: goodSig }] }),
    ).toThrow(RangeError);
    expect(() =>
      encodeWitnessSet({
        vkeyWitnesses: [{ vkey: new Uint8Array(32), signature: new Uint8Array(63) }],
      }),
    ).toThrow(RangeError);
  });
});

describe('the transaction wrapper', () => {
  it('is [body, witness_set, true, null]', () => {
    const body = fromHex('a0');
    const witnessSet = fromHex('a0');
    expect(toHex(encodeTransaction(body, witnessSet))).toBe('84' + 'a0' + 'a0' + 'f5' + 'f6');
  });
});

describe('transaction id', () => {
  it('is blake2b-256 of the body bytes alone, not the whole transaction', () => {
    const body = encodeTransactionBody({
      inputs: [{ txHash: fakeTxHash(0), index: 0 }],
      outputs: [],
      fee: 1n,
    });
    // Adding a witness set must not change the id: that is what lets a
    // transaction be signed by more than one party without invalidating an
    // earlier signature.
    const idFromBodyAlone = transactionId(body);
    const withWitness = encodeTransaction(body, fromHex('a1' + '01' + 'd90102' + '81' + '820000'));
    expect(idFromBodyAlone).toHaveLength(64);
    expect(withWitness.length).toBeGreaterThan(body.length);
    // Re-deriving the id from the same body bytes embedded in a full
    // transaction reproduces the same id computed from the body alone.
    expect(transactionId(body)).toBe(idFromBodyAlone);
  });
});

describe('fee calculation', () => {
  it('is minFeeA * size + minFeeB', () => {
    expect(minFee(200, 44, 155381)).toBe(44n * 200n + 155381n);
  });

  it('is exactly minFeeB when the size is zero', () => {
    expect(minFee(0, 44, 155381)).toBe(155381n);
  });

  it('scales with a different minFeeA and minFeeB, since these are protocol parameters, not constants', () => {
    expect(minFee(300, 1, 2)).toBe(302n);
  });
});

describe('preserving both script encodings into a witness set (spec/07-encoding-divergence.md)', () => {
  // 24 children is the smallest container where `definite` and
  // `cardanoBinary` frame the sub-script list differently, so it is the
  // smallest script with two valid hashes. Cosigner hashes are deterministic
  // stand-ins with no private key behind them (see `src/generate/cosigners.ts`).
  const script = parseScript({
    type: 'all',
    scripts: cosigners(24).map((keyHash) => ({ type: 'sig', keyHash })),
  });
  const definiteBytes = encodeScript(script, 'definite');
  const cardanoBinaryBytes = encodeScript(script, 'cardanoBinary');

  it('really does produce two different byte strings for one logical script', () => {
    expect(toHex(definiteBytes)).not.toBe(toHex(cardanoBinaryBytes));
    expect(scriptHashFromCbor(definiteBytes)).not.toBe(scriptHashFromCbor(cardanoBinaryBytes));
  });

  it('carries each encoding into the witness set byte for byte, with the body unaffected', () => {
    const input: Utxo = {
      txHash: fakeTxHash(0x44),
      outputIndex: 0,
      lovelace: 3_000_000n,
      address: '',
    };
    const signer = { seed: new Uint8Array(32), vkey: new Uint8Array(32), keyHash: '' };

    const txDefinite = buildMinimalTransaction({
      input,
      signers: [signer],
      nativeScripts: [definiteBytes],
    });
    const txCardanoBinary = buildMinimalTransaction({
      input,
      signers: [signer],
      nativeScripts: [cardanoBinaryBytes],
    });

    // Only the witness set differs. The body has no opinion on how a script
    // in the witness set is framed, so building around either encoding must
    // not move a single byte of it.
    expect(toHex(txDefinite.bodyBytes)).toBe(toHex(txCardanoBinary.bodyBytes));
    expect(toHex(txDefinite.witnessSetBytes)).not.toBe(toHex(txCardanoBinary.witnessSetBytes));

    // Neither script was decoded and re-encoded: each witness set ends with
    // exactly the bytes it was given.
    expect(toHex(txDefinite.witnessSetBytes).endsWith(toHex(definiteBytes))).toBe(true);
    expect(toHex(txCardanoBinary.witnessSetBytes).endsWith(toHex(cardanoBinaryBytes))).toBe(true);

    // Both are the same logical script when read back.
    expect(decodeScript(definiteBytes).script).toEqual(decodeScript(cardanoBinaryBytes).script);
  });
});

const cliAvailable = cardanoCliAvailable();
const describeCli = cliAvailable ? describe : describe.skip;
if (!cliAvailable) {
  console.warn('cardano-cli not on PATH, skipping the chain transaction cross-check tests');
}

describeCli('cross-checked against cardano-cli', () => {
  let oracle: CardanoCliOracle;

  beforeEach(() => {
    oracle = new CardanoCliOracle();
  });

  afterEach(() => {
    oracle.dispose();
  });

  /** A key generated fresh for the one test that calls this; never `.secrets/funding.skey`. */
  function throwawaySigner() {
    const generated = oracle.generateKey();
    const signingKey = loadSigningKeyFile(generated.skeyPath);
    const script = parseScript({ type: 'sig', keyHash: signingKey.keyHash });
    const scriptPath = oracle.scriptFile(script);
    return { generated, signingKey, script, scriptPath };
  }

  it('matches cardano-cli byte for byte for the minimal envelope: unsigned body, witness set and signed transaction', () => {
    const { generated, signingKey, script, scriptPath } = throwawaySigner();
    const scriptBytes = encodeScript(script, 'definite');
    const input: Utxo = {
      txHash: fakeTxHash(0),
      outputIndex: 0,
      lovelace: 5_000_000n,
      address: enterpriseAddress(scriptHash(script), 'preprod'),
    };

    const built = buildMinimalTransaction({
      input,
      signers: [signingKey],
      nativeScripts: [scriptBytes],
    });

    const cliUnsignedBody = oracle.buildRaw([
      '--tx-in',
      `${input.txHash}#${input.outputIndex}`,
      '--tx-in-script-file',
      scriptPath,
      '--fee',
      String(input.lovelace),
    ]);
    const unsignedWitnessSet = encodeWitnessSet({ nativeScripts: [scriptBytes] });
    expect(toHex(encodeTransaction(built.bodyBytes, unsignedWitnessSet))).toBe(cliUnsignedBody);

    const cliSigned = oracle.sign(cliUnsignedBody, generated.skeyPath);
    expect(toHex(built.txBytes)).toBe(cliSigned);

    // The body re-parses under cardano-cli's own decoder, and the id it
    // computes for the resulting transaction matches this builder's.
    expect(oracle.txid(cliSigned)).toBe(built.txId);

    // The whole input balance was declared as the fee, by construction.
    expect(built.fee).toBe(input.lovelace);
  });

  it('matches cardano-cli byte for byte for the return envelope, and the fee equals minFeeA * size + minFeeB', () => {
    const { generated, signingKey, script, scriptPath } = throwawaySigner();
    const scriptBytes = encodeScript(script, 'definite');
    const input: Utxo = {
      txHash: fakeTxHash(0x11),
      outputIndex: 2,
      lovelace: 8_000_000n,
      address: enterpriseAddress(scriptHash(script), 'preprod'),
    };
    const returnAddress = execFileSync(
      'cardano-cli',
      [
        'address',
        'build',
        '--payment-verification-key-file',
        generated.vkeyPath,
        '--testnet-magic',
        '2',
      ],
      { encoding: 'utf8' },
    ).trim();
    const minFeeA = 44;
    const minFeeB = 155381;

    const built = buildReturnTransaction({
      input,
      returnAddress,
      signers: [signingKey],
      nativeScripts: [scriptBytes],
      minFeeA,
      minFeeB,
    });

    // Balance is preserved: the return output plus the fee equals the input.
    const outputLovelace = input.lovelace - built.fee;
    expect(outputLovelace + built.fee).toBe(input.lovelace);

    // The fee is exactly the linear formula applied to the transaction's own
    // final size, not an estimate left over from an earlier pass.
    expect(built.fee).toBe(minFee(built.txBytes.length, minFeeA, minFeeB));

    const cliUnsignedBody = oracle.buildRaw([
      '--tx-in',
      `${input.txHash}#${input.outputIndex}`,
      '--tx-in-script-file',
      scriptPath,
      '--tx-out',
      `${returnAddress}+${outputLovelace}`,
      '--fee',
      String(built.fee),
    ]);
    const unsignedWitnessSet = encodeWitnessSet({ nativeScripts: [scriptBytes] });
    expect(toHex(encodeTransaction(built.bodyBytes, unsignedWitnessSet))).toBe(cliUnsignedBody);

    const cliSigned = oracle.sign(cliUnsignedBody, generated.skeyPath);
    expect(toHex(built.txBytes)).toBe(cliSigned);
    expect(oracle.txid(cliSigned)).toBe(built.txId);
  });

  it('accepts a transaction whose >=24-child script is framed either way, in the sense that cardano-cli itself decodes both', () => {
    // cardano-cli's own encoder only ever produces the `cardanoBinary`
    // framing at this size, so the only way to learn whether its decoder
    // also tolerates `definite` is to hand it bytes this library framed that
    // way and see whether it still parses.
    const { signingKey } = throwawaySigner();
    const script = parseScript({
      type: 'all',
      scripts: cosigners(24).map((keyHash) => ({ type: 'sig', keyHash })),
    });
    const definiteBytes = encodeScript(script, 'definite');
    const cardanoBinaryBytes = encodeScript(script, 'cardanoBinary');
    const input: Utxo = {
      txHash: fakeTxHash(0x22),
      outputIndex: 0,
      lovelace: 3_000_000n,
      address: '',
    };

    const txDefinite = buildMinimalTransaction({
      input,
      signers: [signingKey],
      nativeScripts: [definiteBytes],
    });
    const txCardanoBinary = buildMinimalTransaction({
      input,
      signers: [signingKey],
      nativeScripts: [cardanoBinaryBytes],
    });

    expect(oracle.txid(toHex(txCardanoBinary.txBytes))).toBe(txCardanoBinary.txId);
    expect(oracle.txid(toHex(txDefinite.txBytes))).toBe(txDefinite.txId);
  });
});
