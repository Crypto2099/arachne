import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeScript } from '../model/types.js';
import { serializeScript } from '../model/json.js';

/**
 * A thin wrapper over `cardano-cli`, used as an oracle.
 *
 * cardano-cli is Haskell and shares `cardano-api`'s serialization path with the
 * node itself, which makes it a higher authority than any reimplementation.
 * cardano-serialization-lib is an independent Rust implementation, so agreeing
 * with both is worth more than agreeing with either.
 *
 * It is an external binary rather than a dependency, so everything here degrades
 * to "not available" instead of throwing, and the suite that uses it skips.
 */

export interface CliVersion {
  raw: string;
  version: string;
}

export function cliVersion(): CliVersion | null {
  try {
    const raw = execFileSync('cardano-cli', ['--version'], { encoding: 'utf8' }).trim();
    const version = raw.split(/\s+/)[1] ?? 'unknown';
    return { raw, version };
  } catch {
    return null;
  }
}

export function cardanoCliAvailable(): boolean {
  return cliVersion() !== null;
}

/**
 * What cardano-cli did with a script.
 *
 * `refused` is a first-class outcome, not an error. cardano-cli validates more
 * than the ledger does, so a refusal is a finding about the tooling rather than
 * about the script, and the corpus records which shapes it will not build. See
 * spec/07-cardano-cli.md.
 */
export type CliOutcome =
  | { status: 'ok'; value: string }
  | { status: 'refused'; error: string };

export class CliSession {
  private readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'arachne-cli-'));
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private scriptFile(script: NativeScript, name = 'script.json'): string {
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(serializeScript(script)), 'utf8');
    return path;
  }

  private run(args: string[]): CliOutcome {
    try {
      const value = execFileSync('cardano-cli', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      }).trim();
      return { status: 'ok', value };
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string; message?: string };
      // The message is the finding, so it is passed through rather than tidied.
      const text = (e.stderr || e.stdout || e.message || 'unknown failure').toString().trim();
      return { status: 'refused', error: text.replace(/\s+/g, ' ').slice(0, 300) };
    }
  }

  /** `cardano-cli hash script`, the blake2b-224 of the prefixed CBOR. */
  scriptHash(script: NativeScript): CliOutcome {
    return this.run(['hash', 'script', '--script-file', this.scriptFile(script)]);
  }

  /** CIP-19 type 7, script payment credential, no staking. */
  enterpriseAddress(script: NativeScript, network: 'mainnet' | 'testnet'): CliOutcome {
    return this.run([
      'address',
      'build',
      '--payment-script-file',
      this.scriptFile(script),
      ...networkFlag(network),
    ]);
  }

  /** CIP-19 type 3, the same script governing payment and staking. */
  baseAddress(script: NativeScript, network: 'mainnet' | 'testnet'): CliOutcome {
    const payment = this.scriptFile(script, 'payment.json');
    const stake = this.scriptFile(script, 'stake.json');
    return this.run([
      'address',
      'build',
      '--payment-script-file',
      payment,
      '--stake-script-file',
      stake,
      ...networkFlag(network),
    ]);
  }

  /** CIP-19 type 15, reward address over a script stake credential. */
  rewardAddress(script: NativeScript, network: 'mainnet' | 'testnet'): CliOutcome {
    return this.run([
      'conway',
      'stake-address',
      'build',
      '--stake-script-file',
      this.scriptFile(script),
      ...networkFlag(network),
    ]);
  }
}

/**
 * Preview and preprod share network tag 0, and cardano-cli takes a magic rather
 * than a network name. Any testnet magic produces the same address, so the magic
 * chosen here is arbitrary and only the mainnet/testnet distinction matters.
 */
const TESTNET_MAGIC = '2';

function networkFlag(network: 'mainnet' | 'testnet'): string[] {
  return network === 'mainnet' ? ['--mainnet'] : ['--testnet-magic', TESTNET_MAGIC];
}
