import { fromHex } from '../encode/cbor.js';
import type { ScriptHash } from '../model/types.js';
import type { TxCborWriter } from './cbor.js';

/**
 * Conway `certificate`, transaction body field 4, restricted to the
 * alternatives a stake or DRep script credential exercise needs: stake
 * credential registration and unregistration (both the deposit-less legacy
 * form and the deposit-carrying current one), delegation to a stake pool, and
 * DRep registration, update and unregistration. Every one of these carries a
 * SCRIPT credential, never a key hash, because proving a script authorizes
 * the certificate is the point of the exercise.
 *
 * Read from `eras/conway/impl/cddl/data/conway.cddl` in
 * `IntersectMBO/cardano-ledger`. `certificate` is a seventeen-way union;
 * these are the eight alternatives this module emits, quoted with their
 * indices:
 *
 *   credential = [0, addr_keyhash// 1, script_hash]
 *   stake_credential = credential
 *   drep_credential = credential
 *   pool_keyhash = hash28
 *
 *   account_registration_cert = (0, stake_credential)
 *   account_unregistration_cert = (1, stake_credential)
 *   delegation_to_stake_pool_cert = (2, stake_credential, pool_keyhash)
 *   account_registration_deposit_cert = (7, stake_credential, coin)
 *   account_unregistration_deposit_cert = (8, stake_credential, coin)
 *   drep_registration_cert = (16, drep_credential, coin, anchor/ nil)
 *   drep_unregistration_cert = (17, drep_credential, coin)
 *   drep_update_cert = (18, drep_credential, anchor/ nil)
 *
 * Alternatives 0 and 1 are annotated in the CDDL "This certificate will be
 * deprecated in a future era": Conway already prefers the deposit-carrying
 * pair, 7 and 8, and `cardano-cli`'s conway-era certificate commands only
 * emit those, confirmed against `cardano-cli conway stake-address
 * registration-certificate --help` and `deregistration-certificate --help`,
 * both of which require `--key-reg-deposit-amt` with no way to omit it. So
 * `stakeRegistration` and `stakeUnregistration` below, alternatives 0 and 1,
 * have no `cardano-cli` equivalent to cross-check in the conway era; they are
 * cross-checked only by hand-verifying the encoding against the CDDL
 * production directly.
 *
 * `anchor` is always written as `nil` here (never the two-element form), the
 * same default `cardano-cli` uses for a DRep certificate when no
 * `--drep-metadata-url` is given, since none of the exercises this module
 * supports need an anchor.
 */

const HASH28_LENGTH = 28;

function checkHash28(hex: string, label: string): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== HASH28_LENGTH) {
    throw new RangeError(`${label} is ${HASH28_LENGTH} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** `credential = [0, addr_keyhash// 1, script_hash]`, restricted to the script alternative, index 1. */
function writeScriptCredential(writer: TxCborWriter, scriptHash: ScriptHash): void {
  writer.arrayHeader(2).uint(1).bytes(checkHash28(scriptHash, 'a script hash'));
}

export type Certificate =
  /** `account_registration_cert = (0, stake_credential)`. Deposit-less; see the module comment. */
  | { kind: 'stakeRegistration'; stakeScriptHash: ScriptHash }
  /** `account_unregistration_cert = (1, stake_credential)`. Deposit-less; see the module comment. */
  | { kind: 'stakeUnregistration'; stakeScriptHash: ScriptHash }
  /** `delegation_to_stake_pool_cert = (2, stake_credential, pool_keyhash)`. */
  | { kind: 'stakeDelegation'; stakeScriptHash: ScriptHash; poolKeyHash: string }
  /** `account_registration_deposit_cert = (7, stake_credential, coin)`. */
  | { kind: 'stakeRegistrationWithDeposit'; stakeScriptHash: ScriptHash; deposit: bigint }
  /** `account_unregistration_deposit_cert = (8, stake_credential, coin)`. */
  | { kind: 'stakeUnregistrationWithDeposit'; stakeScriptHash: ScriptHash; deposit: bigint }
  /** `drep_registration_cert = (16, drep_credential, coin, anchor/ nil)`. */
  | { kind: 'drepRegistration'; drepScriptHash: ScriptHash; deposit: bigint }
  /** `drep_unregistration_cert = (17, drep_credential, coin)`. */
  | { kind: 'drepUnregistration'; drepScriptHash: ScriptHash; deposit: bigint }
  /** `drep_update_cert = (18, drep_credential, anchor/ nil)`. */
  | { kind: 'drepUpdate'; drepScriptHash: ScriptHash };

/** Write one `certificate`, dispatching on which of the eight alternatives above it is. */
export function writeCertificate(writer: TxCborWriter, cert: Certificate): void {
  switch (cert.kind) {
    case 'stakeRegistration':
      writer.arrayHeader(2).uint(0);
      writeScriptCredential(writer, cert.stakeScriptHash);
      return;
    case 'stakeUnregistration':
      writer.arrayHeader(2).uint(1);
      writeScriptCredential(writer, cert.stakeScriptHash);
      return;
    case 'stakeDelegation':
      writer.arrayHeader(3).uint(2);
      writeScriptCredential(writer, cert.stakeScriptHash);
      writer.bytes(checkHash28(cert.poolKeyHash, 'a pool key hash'));
      return;
    case 'stakeRegistrationWithDeposit':
      writer.arrayHeader(3).uint(7);
      writeScriptCredential(writer, cert.stakeScriptHash);
      writer.uint(cert.deposit);
      return;
    case 'stakeUnregistrationWithDeposit':
      writer.arrayHeader(3).uint(8);
      writeScriptCredential(writer, cert.stakeScriptHash);
      writer.uint(cert.deposit);
      return;
    case 'drepRegistration':
      writer.arrayHeader(4).uint(16);
      writeScriptCredential(writer, cert.drepScriptHash);
      writer.uint(cert.deposit);
      writer.null();
      return;
    case 'drepUnregistration':
      writer.arrayHeader(3).uint(17);
      writeScriptCredential(writer, cert.drepScriptHash);
      writer.uint(cert.deposit);
      return;
    case 'drepUpdate':
      writer.arrayHeader(3).uint(18);
      writeScriptCredential(writer, cert.drepScriptHash);
      writer.null();
      return;
  }
}
