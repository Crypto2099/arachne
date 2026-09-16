import { blake2b } from '@noble/hashes/blake2b';
import { fromHex, toHex } from '../encode/cbor.js';
import { decodeBech32 } from '../encode/credential.js';
import { TxCborWriter, writeSet } from './cbor.js';
import { sign, type SigningKey } from './keys.js';
import type { Utxo } from './provider.js';

/**
 * A minimal Conway transaction builder with exact byte control.
 *
 * This exists because the encoding-divergence experiment needs a native
 * script to enter a witness set exactly as it was encoded, byte for byte,
 * with neither `cardano-serialization-lib`'s always-definite framing nor
 * `cardano-cli`'s `cardanoBinary` framing imposed on top. `src/encode/`
 * already produces both byte strings; everything here treats a script as an
 * opaque `Uint8Array` and never decodes or re-encodes it. See
 * spec/06-chain-exercises.md and spec/07-encoding-divergence.md.
 *
 * Every field encoded and every framing choice below was checked against
 * `cardano-cli conway transaction build-raw` and `transaction sign`, run
 * against throwaway keys generated for that purpose alone (never against
 * `.secrets/funding.skey`), because the CDDL alone under-determines several
 * of them: whether a `set<a0>` field carries CBOR tag 258, the map key order
 * a decoder does not otherwise require, and the legacy two-element output
 * form still accepted alongside the Babbage map form.
 */

const TX_HASH_LENGTH = 32;
const VKEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

export interface TxInput {
  /** Lowercase hex, 32 bytes: the id of the transaction that created this input. */
  txHash: string;
  index: number;
}

export interface TxOutput {
  /** A bech32 address; decoded to its raw payload before encoding. */
  address: string;
  lovelace: bigint;
}

export interface VKeyWitness {
  /** 32-byte ed25519 verification key. */
  vkey: Uint8Array;
  /** 64-byte ed25519 signature. */
  signature: Uint8Array;
}

export interface TransactionBodyFields {
  inputs: TxInput[];
  outputs: TxOutput[];
  fee: bigint;
  /** Field 3, `invalid_hereafter`. Present only when a script in the witness set has a "before". */
  ttl?: bigint;
  /** Field 8, the validity interval start (`invalid_before`). Present only for an "after". */
  validityStart?: bigint;
}

export interface WitnessSetFields {
  vkeyWitnesses?: VKeyWitness[];
  /**
   * Each entry is one native script's own CBOR, exactly as the caller
   * encoded it: `encodeScript(script, 'definite')`, `encodeScript(script,
   * 'cardanoBinary')`, or bytes from anywhere else. Spliced unmodified.
   */
  nativeScripts?: Uint8Array[];
}

function writeInput(writer: TxCborWriter, input: TxInput): void {
  const hash = fromHex(input.txHash);
  if (hash.length !== TX_HASH_LENGTH) {
    throw new RangeError(`a transaction hash is ${TX_HASH_LENGTH} bytes, got ${hash.length}`);
  }
  writer.arrayHeader(2).bytes(hash).uint(input.index);
}

function writeOutput(writer: TxCborWriter, output: TxOutput): void {
  if (output.lovelace < 0n) throw new RangeError('an output cannot carry negative lovelace');
  const { bytes } = decodeBech32(output.address);
  // `shelley_transaction_output = [address, amount, ? datum_hash]`. Still
  // valid in Conway alongside the newer Babbage map form, and what
  // `cardano-cli conway transaction build-raw --tx-out` itself emits for an
  // ada-only output carrying no datum and no reference script.
  writer.arrayHeader(2).bytes(bytes).uint(output.lovelace);
}

/**
 * Encode a Conway `transaction_body`: field 0 inputs, field 1 outputs, field
 * 2 fee, optional field 3 ttl and field 8 validity interval start.
 *
 * Map keys are written in ascending order, matching what `cardano-cli`
 * itself emits; a decoder does not require this, but matching it keeps a
 * byte-for-byte comparison against the cardano-cli oracle meaningful.
 */
export function encodeTransactionBody(fields: TransactionBodyFields): Uint8Array {
  if (fields.inputs.length === 0) {
    throw new RangeError('a transaction body needs at least one input');
  }
  if (fields.fee < 0n) throw new RangeError('fee cannot be negative');

  const fieldCount =
    3 + (fields.ttl !== undefined ? 1 : 0) + (fields.validityStart !== undefined ? 1 : 0);

  const writer = new TxCborWriter();
  writer.mapHeader(fieldCount);

  writer.uint(0);
  writeSet(writer, fields.inputs, writeInput);

  writer.uint(1).arrayHeader(fields.outputs.length);
  for (const output of fields.outputs) writeOutput(writer, output);

  writer.uint(2).uint(fields.fee);

  if (fields.ttl !== undefined) writer.uint(3).uint(fields.ttl);
  if (fields.validityStart !== undefined) writer.uint(8).uint(fields.validityStart);

  return writer.toBytes();
}

/**
 * Encode a Conway `transaction_witness_set`: field 0 vkey witnesses, field 1
 * native scripts. A field absent from `fields`, or present but empty, is
 * omitted from the map entirely rather than written as a tagged empty set,
 * since both are `nonempty_set` in the CDDL and cardano-cli never emits one
 * empty.
 */
export function encodeWitnessSet(fields: WitnessSetFields): Uint8Array {
  const vkeyWitnesses = fields.vkeyWitnesses ?? [];
  const nativeScripts = fields.nativeScripts ?? [];
  const fieldCount = (vkeyWitnesses.length > 0 ? 1 : 0) + (nativeScripts.length > 0 ? 1 : 0);

  const writer = new TxCborWriter();
  writer.mapHeader(fieldCount);

  if (vkeyWitnesses.length > 0) {
    writer.uint(0);
    writeSet(writer, vkeyWitnesses, (w, witness) => {
      if (witness.vkey.length !== VKEY_LENGTH) {
        throw new RangeError(`a vkey is ${VKEY_LENGTH} bytes, got ${witness.vkey.length}`);
      }
      if (witness.signature.length !== SIGNATURE_LENGTH) {
        throw new RangeError(
          `a signature is ${SIGNATURE_LENGTH} bytes, got ${witness.signature.length}`,
        );
      }
      w.arrayHeader(2).bytes(witness.vkey).bytes(witness.signature);
    });
  }

  if (nativeScripts.length > 0) {
    writer.uint(1);
    writeSet(writer, nativeScripts, (w, script) => w.raw(script));
  }

  return writer.toBytes();
}

/**
 * `[transaction_body, transaction_witness_set, bool, auxiliary_data]`. Every
 * exercise builds `is_valid = true` (the phase-2-failure flag is a Plutus
 * concern, unreachable for a native script) and carries no auxiliary data.
 */
export function encodeTransaction(bodyBytes: Uint8Array, witnessSetBytes: Uint8Array): Uint8Array {
  return new TxCborWriter()
    .arrayHeader(4)
    .raw(bodyBytes)
    .raw(witnessSetBytes)
    .true()
    .null()
    .toBytes();
}

/**
 * blake2b-256 of a serialized `transaction_body`, as raw bytes. This is the
 * transaction id, and it is what a vkey witness signs: a witness set added
 * afterward never changes it, which is exactly what lets the body be built
 * once and only the signatures redone.
 */
export function transactionIdBytes(bodyBytes: Uint8Array): Uint8Array {
  return blake2b(bodyBytes, { dkLen: 32 });
}

/** `transactionIdBytes`, as lowercase hex, matching `cardano-cli conway transaction txid`. */
export function transactionId(bodyBytes: Uint8Array): string {
  return toHex(transactionIdBytes(bodyBytes));
}

/**
 * The linear fee: `minFeeA * txSize + minFeeB`. `minFeeA` and `minFeeB` are
 * protocol parameters, queried from the network rather than fixed by any
 * spec, so they are always passed in rather than assumed here.
 */
export function minFee(txSizeBytes: number, minFeeA: number, minFeeB: number): bigint {
  return BigInt(minFeeA) * BigInt(txSizeBytes) + BigInt(minFeeB);
}

export interface BuiltTransaction {
  bodyBytes: Uint8Array;
  witnessSetBytes: Uint8Array;
  txBytes: Uint8Array;
  /** Lowercase hex. */
  txId: string;
  fee: bigint;
}

export interface MinimalTransactionParams {
  /** The one input spent, whose entire balance becomes the fee. */
  input: Utxo;
  signers: SigningKey[];
  nativeScripts?: Uint8Array[];
  ttl?: bigint;
  validityStart?: bigint;
}

/**
 * The minimal envelope: one input, zero outputs, the input's entire balance
 * declared as the fee. `transaction_body` field 1 is `[* transaction_output]`
 * and admits the empty list, and value is preserved because the sum of
 * inputs equals the fee exactly, so no fee calculation is needed at all:
 * whatever the input holds clears the minimum because it is the whole
 * balance. This is the envelope for measuring a script against `maxTxSize`
 * with as little else in the way as possible. See spec/06-chain-exercises.md.
 */
export function buildMinimalTransaction(params: MinimalTransactionParams): BuiltTransaction {
  const bodyBytes = encodeTransactionBody({
    inputs: [{ txHash: params.input.txHash, index: params.input.outputIndex }],
    outputs: [],
    fee: params.input.lovelace,
    ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
    ...(params.validityStart !== undefined ? { validityStart: params.validityStart } : {}),
  });

  const txIdBytes = transactionIdBytes(bodyBytes);
  const vkeyWitnesses = params.signers.map((signer) => ({
    vkey: signer.vkey,
    signature: sign(signer, txIdBytes),
  }));

  const witnessSetBytes = encodeWitnessSet({
    ...(vkeyWitnesses.length > 0 ? { vkeyWitnesses } : {}),
    ...(params.nativeScripts && params.nativeScripts.length > 0
      ? { nativeScripts: params.nativeScripts }
      : {}),
  });

  return {
    bodyBytes,
    witnessSetBytes,
    txBytes: encodeTransaction(bodyBytes, witnessSetBytes),
    txId: toHex(txIdBytes),
    fee: params.input.lovelace,
  };
}

export interface ReturnTransactionParams {
  /** The one input spent. */
  input: Utxo;
  /** Where the balance, minus the fee, is returned. */
  returnAddress: string;
  signers: SigningKey[];
  nativeScripts?: Uint8Array[];
  minFeeA: number;
  minFeeB: number;
  ttl?: bigint;
  validityStart?: bigint;
}

/** A signature-shaped placeholder, exactly `SIGNATURE_LENGTH` bytes, for measuring size before signing. */
const DUMMY_SIGNATURE = new Uint8Array(SIGNATURE_LENGTH);

/** Bounds the fee/size convergence loop in `buildReturnTransaction`. Two is normally enough; four leaves margin. */
const MAX_FEE_ITERATIONS = 4;

/**
 * The return envelope: one input, one output back to `returnAddress`, fee
 * deducted. This is the ordinary case, since testnet ADA should come back to
 * the funding address rather than being burned as an inflated fee.
 *
 * A transaction's size depends on its signatures, and a signature cannot be
 * produced before the fee that determines the output value being signed
 * over is fixed. Every real ed25519 signature is exactly 64 bytes regardless
 * of what it signs, so a same-length placeholder measures the true size
 * without knowing the real signature; only the fee integer's own CBOR width
 * can still move between a guess and the size that guess produces, at the
 * boundary between width classes, so the fee is settled by iterating body
 * and witness set to a fixed point rather than by trusting a single guess,
 * before the real signatures are produced in one final pass.
 */
export function buildReturnTransaction(params: ReturnTransactionParams): BuiltTransaction {
  const input: TxInput = { txHash: params.input.txHash, index: params.input.outputIndex };
  const nativeScripts = params.nativeScripts ?? [];

  const bodyForFee = (fee: bigint): Uint8Array =>
    encodeTransactionBody({
      inputs: [input],
      outputs: [{ address: params.returnAddress, lovelace: params.input.lovelace - fee }],
      fee,
      ...(params.ttl !== undefined ? { ttl: params.ttl } : {}),
      ...(params.validityStart !== undefined ? { validityStart: params.validityStart } : {}),
    });

  const witnessSetFor = (signatures: readonly Uint8Array[]): Uint8Array => {
    const vkeyWitnesses = params.signers.map((signer, i) => ({
      vkey: signer.vkey,
      signature: signatures[i] as Uint8Array,
    }));
    return encodeWitnessSet({
      ...(vkeyWitnesses.length > 0 ? { vkeyWitnesses } : {}),
      ...(nativeScripts.length > 0 ? { nativeScripts } : {}),
    });
  };

  const dummyWitnessSetBytes = witnessSetFor(params.signers.map(() => DUMMY_SIGNATURE));

  let fee = BigInt(params.minFeeB);
  let bodyBytes = bodyForFee(fee);
  for (let i = 0; i < MAX_FEE_ITERATIONS; i += 1) {
    const measuredSize = encodeTransaction(bodyBytes, dummyWitnessSetBytes).length;
    const nextFee = minFee(measuredSize, params.minFeeA, params.minFeeB);
    if (nextFee === fee) break;
    fee = nextFee;
    bodyBytes = bodyForFee(fee);
  }

  const txIdBytes = transactionIdBytes(bodyBytes);
  const witnessSetBytes = witnessSetFor(params.signers.map((signer) => sign(signer, txIdBytes)));

  return {
    bodyBytes,
    witnessSetBytes,
    txBytes: encodeTransaction(bodyBytes, witnessSetBytes),
    txId: toHex(txIdBytes),
    fee,
  };
}
