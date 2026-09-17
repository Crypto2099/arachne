import { describe, expect, it } from 'vitest';
import { loadChainEvidence } from '../../src/chain/evidence.js';
import { fetchTxStatuses, koiosReachable, type KoiosNetwork } from '../../src/chain/koios.js';

/**
 * Checks every accepted txHash in chain-evidence/observations.json against
 * Koios, the one part of this record that cannot be verified offline: the
 * hashes were transcribed by hand from spec prose, and the only way to know
 * a transcription is correct is to ask a node's own index whether that
 * transaction exists.
 *
 * A rejected submission is skipped rather than checked, deliberately: it has
 * no `txHash`, because a rejected transaction never reaches a chain and so
 * never receives one, and there is nothing for Koios to resolve. Filtering
 * on `accepted` is what does this; it is not an oversight to fix later.
 *
 * Modeled on the `cli` project: an external dependency, here a reachable
 * network rather than a binary on PATH, decides whether this project runs
 * at all, and it skips cleanly rather than failing when that dependency is
 * absent, so an offline machine is unaffected.
 */
const reachable = await koiosReachable();
const describeKoios = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn('Koios preprod API unreachable, skipping the koios verification project');
}

describeKoios('every accepted txHash in the chain evidence record resolves on Koios', () => {
  it('finds every hash with at least one confirmation, and skips every rejection', async () => {
    const record = await loadChainEvidence();
    const accepted = record.entries.filter((e) => e.accepted && e.txHash);
    const rejected = record.entries.filter((e) => !e.accepted);

    // A rejection has no hash to look up, so it is excluded from the Koios
    // request rather than treated as a failure to find one.
    expect(rejected.every((e) => e.txHash === undefined)).toBe(true);
    expect(accepted.length + rejected.length).toBe(record.entries.length);

    const byNetwork = new Map<KoiosNetwork, string[]>();
    for (const entry of accepted) {
      const network = entry.network as KoiosNetwork;
      const hashes = byNetwork.get(network) ?? [];
      hashes.push(entry.txHash as string);
      byNetwork.set(network, hashes);
    }

    const missing: string[] = [];
    let checked = 0;

    for (const [network, hashes] of byNetwork) {
      const statuses = await fetchTxStatuses(network, hashes);
      const byHash = new Map(statuses.map((s) => [s.tx_hash, s.num_confirmations]));
      for (const hash of hashes) {
        checked += 1;
        const confirmations = byHash.get(hash);
        if (confirmations === undefined || confirmations === null || confirmations <= 0) {
          missing.push(`${network}/${hash}`);
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `verified ${checked} transaction hashes against Koios, skipped ${rejected.length} rejections`,
    );
    expect(missing).toEqual([]);
    expect(checked).toBe(accepted.length);
  });
});
