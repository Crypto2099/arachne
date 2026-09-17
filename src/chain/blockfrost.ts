import type { ChainProvider, ProtocolParams, SubmitResult, Testnet, Utxo } from './provider.js';
import { ProviderError } from './provider.js';
import { toHex } from '../encode/cbor.js';

const BASE: Record<Testnet, string> = {
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
};

export class BlockfrostProvider implements ChainProvider {
  readonly network: Testnet;
  private readonly projectId: string;

  constructor(network: Testnet, projectId: string) {
    if (!projectId) throw new Error('BLOCKFROST_PROJECT_ID is not set');
    this.network = network;
    this.projectId = projectId;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${BASE[this.network]}${path}`, {
      headers: { project_id: this.projectId },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderError(`GET ${path} failed with ${response.status}`, response.status, body);
    }
    return JSON.parse(body) as T;
  }

  async protocolParams(): Promise<ProtocolParams> {
    const raw = await this.get<Record<string, unknown>>('/epochs/latest/parameters');
    return {
      maxTxSize: Number(raw['max_tx_size']),
      maxValSize: Number(raw['max_val_size']),
      minFeeA: Number(raw['min_fee_a']),
      minFeeB: Number(raw['min_fee_b']),
      keyDeposit: Number(raw['key_deposit']),
      poolDeposit: Number(raw['pool_deposit']),
      drepDeposit: Number(raw['drep_deposit'] ?? 0),
      ...(raw['min_fee_ref_script_cost_per_byte'] === undefined ||
      raw['min_fee_ref_script_cost_per_byte'] === null
        ? {}
        : {
            minFeeRefScriptCostPerByte: Number(raw['min_fee_ref_script_cost_per_byte']),
          }),
    };
  }

  async utxosAt(address: string): Promise<Utxo[]> {
    try {
      const raw = await this.get<
        { tx_hash: string; output_index: number; amount: { unit: string; quantity: string }[] }[]
      >(`/addresses/${address}/utxos`);
      return raw.map((u) => ({
        txHash: u.tx_hash,
        outputIndex: u.output_index,
        lovelace: BigInt(u.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'),
        address,
      }));
    } catch (error) {
      // An address a node has never seen is a 404, which means no UTxOs rather
      // than a failure. Every generated script address starts out in this state.
      if (error instanceof ProviderError && error.status === 404) return [];
      throw error;
    }
  }

  async currentSlot(): Promise<number> {
    const raw = await this.get<{ slot: number }>('/blocks/latest');
    return raw.slot;
  }

  /**
   * Submit and report, never throw on rejection.
   *
   * A rejected transaction is the result of an exercise, not an error in it.
   * The node's message is the finding, so it is returned verbatim for the
   * corpus to record. This is how a nesting or size limit gets discovered:
   * something is refused, and the refusal says why.
   *
   * `cborHex` is captured on both outcomes, from the same bytes that were
   * sent, so a rejection keeps its transaction rather than losing it: a
   * rejected transaction never reaches a chain and cannot be refetched or
   * rebuilt afterward, unlike an accepted one, which stays retrievable by
   * `txHash` for as long as the chain exists.
   */
  async submit(txCbor: Uint8Array): Promise<SubmitResult> {
    const cborHex = toHex(txCbor);
    const response = await fetch(`${BASE[this.network]}/tx/submit`, {
      method: 'POST',
      headers: {
        project_id: this.projectId,
        'Content-Type': 'application/cbor',
      },
      body: txCbor,
    });
    const body = await response.text();
    if (!response.ok) return { accepted: false, error: body, cborHex };
    return { accepted: true, txHash: body.replaceAll('"', ''), cborHex };
  }
}
