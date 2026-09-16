import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeScript } from '../../../../src/model/json.js';
import type { NativeScript } from '../../../../src/model/types.js';
import type { SigningKeyEnvelope } from '../../../../src/chain/keys.js';

/**
 * A throwaway `cardano-cli` session for cross-checking the transaction
 * builder offline, mirroring `src/vectors/cardano-cli.ts`'s use of the
 * binary as an oracle rather than a dependency.
 *
 * Every key this generates is freshly created in a private temp directory for
 * the one test that asked for it and is deleted by `dispose()`. None of them
 * is `.secrets/funding.skey`, and none is ever funded; nothing here reads
 * that directory or any of its contents.
 */

export function cardanoCliAvailable(): boolean {
  try {
    execFileSync('cardano-cli', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface TextEnvelope {
  type: string;
  description: string;
  cborHex: string;
}

export interface GeneratedKey {
  skeyPath: string;
  vkeyPath: string;
  keyHash: string;
}

/**
 * A certificate or vote file `cardano-cli` wrote, together with the
 * `cborHex` it contains: the path is what `transaction build-raw`'s
 * `--certificate-file` and `--vote-file` need, and the hex is what a
 * byte-for-byte comparison against this builder's own encoding needs.
 */
export interface CliDocument {
  path: string;
  cborHex: string;
}

/** Preview and preprod share network tag 0; any testnet magic yields the same credential. */
const TESTNET_MAGIC = '2';

export class CardanoCliOracle {
  private readonly dir: string;
  private counter = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'arachne-chain-cli-'));
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private freshPath(suffix: string): string {
    this.counter += 1;
    return join(this.dir, `${this.counter}-${suffix}`);
  }

  private run(args: string[]): string {
    return execFileSync('cardano-cli', args, { encoding: 'utf8', timeout: 60_000 }).trim();
  }

  private readEnvelope(path: string): TextEnvelope {
    return JSON.parse(readFileSync(path, 'utf8')) as TextEnvelope;
  }

  /** A fresh throwaway ed25519 payment key pair. */
  generateKey(): GeneratedKey {
    const vkeyPath = this.freshPath('key.vkey');
    const skeyPath = this.freshPath('key.skey');
    const keyHashPath = this.freshPath('key.hash');
    this.run([
      'address',
      'key-gen',
      '--verification-key-file',
      vkeyPath,
      '--signing-key-file',
      skeyPath,
    ]);
    this.run([
      'address',
      'key-hash',
      '--payment-verification-key-file',
      vkeyPath,
      '--out-file',
      keyHashPath,
    ]);
    return { skeyPath, vkeyPath, keyHash: readFileSync(keyHashPath, 'utf8').trim() };
  }

  readSigningKeyEnvelope(skeyPath: string): SigningKeyEnvelope {
    return this.readEnvelope(skeyPath) as SigningKeyEnvelope;
  }

  /** The verification key's own 32-byte payload, read the same way a signing key's is. */
  readVerificationKeyBytes(vkeyPath: string): string {
    const envelope = this.readEnvelope(vkeyPath);
    // Same envelope shape as a signing key: a CBOR byte string, `0x58 0x20`
    // then 32 bytes.
    return envelope.cborHex.slice(4);
  }

  scriptFile(script: NativeScript): string {
    const path = this.freshPath('script.json');
    writeFileSync(path, JSON.stringify(serializeScript(script)), 'utf8');
    return path;
  }

  enterpriseAddress(scriptPath: string): string {
    return this.run([
      'address',
      'build',
      '--payment-script-file',
      scriptPath,
      '--testnet-magic',
      TESTNET_MAGIC,
    ]);
  }

  /** A fresh throwaway stake pool identity: a cold key pair, reduced to its pool id, hex-encoded, 28 bytes. */
  generatePoolIdHex(): string {
    const coldVkey = this.freshPath('pool-cold.vkey');
    const coldSkey = this.freshPath('pool-cold.skey');
    const counter = this.freshPath('pool-cold.counter');
    this.run([
      'conway',
      'node',
      'key-gen',
      '--cold-verification-key-file',
      coldVkey,
      '--cold-signing-key-file',
      coldSkey,
      '--operational-certificate-issue-counter-file',
      counter,
    ]);
    const outPath = this.freshPath('pool.id.hex');
    this.run([
      'conway',
      'stake-pool',
      'id',
      '--cold-verification-key-file',
      coldVkey,
      '--output-format',
      'hex',
      '--out-file',
      outPath,
    ]);
    return readFileSync(outPath, 'utf8').trim();
  }

  /** `cardano-cli conway stake-address registration-certificate`, always the deposit-carrying form; see src/chain/certificates.ts. */
  stakeRegistrationCertificate(scriptPath: string, depositAmt: bigint): CliDocument {
    const path = this.freshPath('stake-reg.cert');
    this.run([
      'conway',
      'stake-address',
      'registration-certificate',
      '--stake-script-file',
      scriptPath,
      '--key-reg-deposit-amt',
      String(depositAmt),
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway stake-address deregistration-certificate`, always the deposit-carrying form; see src/chain/certificates.ts. */
  stakeDeregistrationCertificate(scriptPath: string, depositAmt: bigint): CliDocument {
    const path = this.freshPath('stake-dereg.cert');
    this.run([
      'conway',
      'stake-address',
      'deregistration-certificate',
      '--stake-script-file',
      scriptPath,
      '--key-reg-deposit-amt',
      String(depositAmt),
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway stake-address stake-delegation-certificate`. */
  stakeDelegationCertificate(scriptPath: string, poolIdHex: string): CliDocument {
    const path = this.freshPath('stake-deleg.cert');
    this.run([
      'conway',
      'stake-address',
      'stake-delegation-certificate',
      '--stake-script-file',
      scriptPath,
      '--stake-pool-id',
      poolIdHex,
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway governance drep registration-certificate`. */
  drepRegistrationCertificate(drepScriptHashHex: string, depositAmt: bigint): CliDocument {
    const path = this.freshPath('drep-reg.cert');
    this.run([
      'conway',
      'governance',
      'drep',
      'registration-certificate',
      '--drep-script-hash',
      drepScriptHashHex,
      '--key-reg-deposit-amt',
      String(depositAmt),
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway governance drep retirement-certificate`, the CLI's name for `drep_unregistration_cert`. */
  drepRetirementCertificate(drepScriptHashHex: string, depositAmt: bigint): CliDocument {
    const path = this.freshPath('drep-retire.cert');
    this.run([
      'conway',
      'governance',
      'drep',
      'retirement-certificate',
      '--drep-script-hash',
      drepScriptHashHex,
      '--deposit-amt',
      String(depositAmt),
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway governance drep update-certificate`, with no anchor. */
  drepUpdateCertificate(drepScriptHashHex: string): CliDocument {
    const path = this.freshPath('drep-update.cert');
    this.run([
      'conway',
      'governance',
      'drep',
      'update-certificate',
      '--drep-script-hash',
      drepScriptHashHex,
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway governance vote create`, a DRep script voting on one governance action, with no anchor. */
  voteCreate(
    choice: 'yes' | 'no' | 'abstain',
    drepScriptHashHex: string,
    govActionTxId: string,
    govActionIndex: number,
  ): CliDocument {
    const path = this.freshPath('vote.out');
    this.run([
      'conway',
      'governance',
      'vote',
      'create',
      `--${choice}`,
      '--drep-script-hash',
      drepScriptHashHex,
      '--governance-action-tx-id',
      govActionTxId,
      '--governance-action-index',
      String(govActionIndex),
      '--out-file',
      path,
    ]);
    return { path, cborHex: this.readEnvelope(path).cborHex };
  }

  /** `cardano-cli conway transaction build-raw`, returning the produced envelope's `cborHex`. */
  buildRaw(args: string[]): string {
    const outPath = this.freshPath('build-raw.out');
    this.run(['conway', 'transaction', 'build-raw', ...args, '--out-file', outPath]);
    return this.readEnvelope(outPath).cborHex;
  }

  /** `cardano-cli conway transaction sign`, given an unsigned tx's `cborHex`. */
  sign(txCborHex: string, skeyPath: string): string {
    const bodyPath = this.freshPath('sign.in');
    writeFileSync(
      bodyPath,
      JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: txCborHex }),
      'utf8',
    );
    const outPath = this.freshPath('sign.out');
    this.run([
      'conway',
      'transaction',
      'sign',
      '--tx-body-file',
      bodyPath,
      '--signing-key-file',
      skeyPath,
      '--testnet-magic',
      TESTNET_MAGIC,
      '--out-file',
      outPath,
    ]);
    return this.readEnvelope(outPath).cborHex;
  }

  /** `cardano-cli conway transaction txid --tx-file`, given a full tx's `cborHex`. */
  txid(txCborHex: string): string {
    const path = this.freshPath('txid.in');
    writeFileSync(
      path,
      JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: txCborHex }),
      'utf8',
    );
    return this.run(['conway', 'transaction', 'txid', '--tx-file', path]);
  }
}
