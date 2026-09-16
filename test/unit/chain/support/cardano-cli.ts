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
