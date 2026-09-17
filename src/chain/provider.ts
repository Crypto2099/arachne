import type { Network } from '../encode/credential.js';

export type Testnet = Exclude<Network, 'mainnet'>;

export interface ProtocolParams {
  maxTxSize: number;
  maxValSize: number;
  minFeeA: number;
  minFeeB: number;
  keyDeposit: number;
  poolDeposit: number;
  drepDeposit: number;
  /** Conway reference-script fee base. Absent on a node that predates it. */
  minFeeRefScriptCostPerByte?: number;
}

export interface Utxo {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  address: string;
}

export interface SubmitResult {
  accepted: boolean;
  txHash?: string;
  /** The submit endpoint's verbatim error. Recorded unmodified into the corpus. */
  error?: string;
  /**
   * The submitted transaction's raw CBOR, lowercase hex.
   *
   * Set by the implementation from the `txCbor` it was given, on both
   * outcomes. An accepted transaction's bytes stay retrievable from the chain
   * by `txHash` afterward; a rejected one never reaches a chain and its
   * bytes exist nowhere else, so losing them here loses them for good.
   */
  cborHex?: string;
}

/**
 * The read and submit surface a chain exercise needs.
 *
 * Kept this narrow on purpose. Arachne asks a node one question, "do you accept
 * this transaction", and the answer is worth recording only if the error text
 * survives intact. A provider that normalizes or prettifies errors destroys the
 * evidence, so implementations pass the body through untouched.
 */
export interface ChainProvider {
  readonly network: Testnet;
  protocolParams(): Promise<ProtocolParams>;
  utxosAt(address: string): Promise<Utxo[]>;
  currentSlot(): Promise<number>;
  submit(txCbor: Uint8Array): Promise<SubmitResult>;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}
