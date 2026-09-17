/**
 * A minimal Koios `tx_status` client, used only to check that a transaction
 * hash recorded in the chain evidence record actually exists on the network
 * it claims. Koios needs no API key, which is why it is the oracle for this
 * check rather than Blockfrost, which the exercise provider uses instead.
 *
 * Endpoint documented at https://api.koios.rest, path `/tx_status`:
 *
 *     curl -s -X POST https://preprod.koios.rest/api/v1/tx_status \
 *       -H 'content-type: application/json' -d '{"_tx_hashes":["<hash>", ...]}'
 *
 * It returns one object per hash in `_tx_hashes`, in the same order,
 * `num_confirmations` null when the hash is not found.
 */
export type KoiosNetwork = 'mainnet' | 'preprod' | 'preview';

const KOIOS_HOST: Record<KoiosNetwork, string> = {
  mainnet: 'https://api.koios.rest',
  preprod: 'https://preprod.koios.rest',
  preview: 'https://preview.koios.rest',
};

export interface KoiosTxStatus {
  tx_hash: string;
  num_confirmations: number | null;
}

export async function fetchTxStatuses(
  network: KoiosNetwork,
  txHashes: string[],
  signal?: AbortSignal,
): Promise<KoiosTxStatus[]> {
  const response = await fetch(`${KOIOS_HOST[network]}/api/v1/tx_status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _tx_hashes: txHashes }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(
      `Koios tx_status on ${network} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as KoiosTxStatus[];
}

/**
 * Probes reachability with an empty request, which Koios answers with `[]`
 * rather than an error. Used to decide whether the opt-in chain check should
 * run at all, so an offline machine skips cleanly instead of failing.
 */
export async function koiosReachable(
  network: KoiosNetwork = 'preprod',
  timeoutMs = 5_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchTxStatuses(network, [], controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
