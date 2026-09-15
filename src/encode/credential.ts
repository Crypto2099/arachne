import { bech32 } from '@scure/base';
import { fromHex, toHex } from './cbor.js';

/**
 * Credential surfaces a script hash can occupy.
 *
 * Every constant here is read from the specification rather than recalled:
 * address layout from CIP-19, governance identifiers from CIP-129, and the
 * legacy governance bech32 forms from CIP-105. Section references are in
 * spec/02-encoding.md.
 */

export type Network = 'mainnet' | 'preview' | 'preprod';

/** CIP-19: header bits [3:0]. Every testnet shares tag 0. */
export function networkTag(network: Network): number {
  return network === 'mainnet' ? 0b0001 : 0b0000;
}

/**
 * CIP-19 Shelley address types, header bits [7:4]. Only the script-credential
 * rows are listed, because a script hash cannot occupy a key-credential slot.
 * Odd type numbers carry a script payment credential.
 */
export const ADDRESS_TYPE = {
  /** script payment, key stake */
  scriptKey: 0b0001,
  /** script payment, script stake */
  scriptScript: 0b0011,
  /** script payment, pointer stake */
  scriptPointer: 0b0101,
  /** script payment, no stake credential (enterprise) */
  scriptOnly: 0b0111,
  /** reward address holding a script stake credential */
  rewardScript: 0b1111,
} as const;

function addressPrefix(network: Network): string {
  return network === 'mainnet' ? 'addr' : 'addr_test';
}

function rewardPrefix(network: Network): string {
  return network === 'mainnet' ? 'stake' : 'stake_test';
}

/**
 * Cardano addresses are longer than the 90-character ceiling in BIP-173, and
 * CIP-19 states the limit does not apply. Every encode and decode here passes
 * `false` to disable it. A port using a stock bech32 library that enforces 90
 * will fail on base addresses and succeed on enterprise ones, which reads as an
 * unrelated bug.
 */
const NO_LIMIT = false as const;

function encodeBech32(prefix: string, payload: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(payload), NO_LIMIT);
}

export function decodeBech32(value: string): { prefix: string; bytes: Uint8Array } {
  const decoded = bech32.decode(value as `${string}1${string}`, NO_LIMIT);
  return { prefix: decoded.prefix, bytes: Uint8Array.from(bech32.fromWords(decoded.words)) };
}

/** Enterprise address: script payment credential, no staking. CIP-19 type 7. */
export function enterpriseAddress(scriptHash: string, network: Network): string {
  const header = (ADDRESS_TYPE.scriptOnly << 4) | networkTag(network);
  return encodeBech32(addressPrefix(network), concat([header], fromHex(scriptHash)));
}

/**
 * Base address with the same script governing both payment and staking. CIP-19
 * type 3. This is the shape a multisig treasury normally takes, and the one
 * where a single script hash appears twice in one address.
 */
export function baseAddressScriptStake(
  paymentScriptHash: string,
  stakeScriptHash: string,
  network: Network,
): string {
  const header = (ADDRESS_TYPE.scriptScript << 4) | networkTag(network);
  return encodeBech32(
    addressPrefix(network),
    concat([header], fromHex(paymentScriptHash), fromHex(stakeScriptHash)),
  );
}

/** Base address with a script payment credential and a key stake credential. CIP-19 type 1. */
export function baseAddressKeyStake(
  paymentScriptHash: string,
  stakeKeyHash: string,
  network: Network,
): string {
  const header = (ADDRESS_TYPE.scriptKey << 4) | networkTag(network);
  return encodeBech32(
    addressPrefix(network),
    concat([header], fromHex(paymentScriptHash), fromHex(stakeKeyHash)),
  );
}

/** Reward address over a script stake credential. CIP-19 type 15. */
export function rewardAddress(scriptHash: string, network: Network): string {
  const header = (ADDRESS_TYPE.rewardScript << 4) | networkTag(network);
  return encodeBech32(rewardPrefix(network), concat([header], fromHex(scriptHash)));
}

/**
 * CIP-129 governance identifiers. Header bits [7:4] are the key type and bits
 * [3:0] the credential type. Credential types 0 and 1 are reserved so a
 * governance identifier can never be confused with an address network tag.
 */
export const GOV_KEY_TYPE = {
  ccHot: 0b0000,
  ccCold: 0b0001,
  drep: 0b0010,
} as const;

export const GOV_CREDENTIAL_TYPE = {
  keyHash: 0b0010,
  scriptHash: 0b0011,
} as const;

export type GovRole = keyof typeof GOV_KEY_TYPE;

const GOV_PREFIX: Record<GovRole, string> = {
  ccHot: 'cc_hot',
  ccCold: 'cc_cold',
  drep: 'drep',
};

/**
 * CIP-105 kept a separate bech32 prefix per credential kind and encoded the
 * bare 28-byte hash with no header. CIP-129 supersedes it, but wallets and
 * indexers still emit and accept the old form, so a corpus has to carry both.
 */
const GOV_PREFIX_LEGACY_SCRIPT: Record<GovRole, string> = {
  ccHot: 'cc_hot_script',
  ccCold: 'cc_cold_script',
  drep: 'drep_script',
};

/** CIP-129 form: one header byte then the 28-byte hash, 29 bytes decoded. */
export function govIdCip129(scriptHash: string, role: GovRole): string {
  const header = (GOV_KEY_TYPE[role] << 4) | GOV_CREDENTIAL_TYPE.scriptHash;
  return encodeBech32(GOV_PREFIX[role], concat([header], fromHex(scriptHash)));
}

/** CIP-105 form: the bare 28-byte hash under a credential-specific prefix. */
export function govIdCip105(scriptHash: string, role: GovRole): string {
  return encodeBech32(GOV_PREFIX_LEGACY_SCRIPT[role], fromHex(scriptHash));
}

/**
 * `drep1...` is ambiguous. CIP-129 and CIP-105 both claim the prefix, and only
 * the decoded length tells them apart: 29 bytes is CIP-129 and carries a header
 * naming the credential type, 28 bytes is CIP-105 and is a bare key hash whose
 * credential type is not recoverable from the identifier at all.
 *
 * A resolver that assumes one form silently misreads the other. Reading the
 * first byte to decide is worse than useless, since a bare hash beginning 0x22
 * is a perfectly ordinary hash.
 */
export interface DecodedGovId {
  role: GovRole | null;
  format: 'cip129' | 'cip105';
  credentialType: 'keyHash' | 'scriptHash' | 'unknown';
  hash: string;
}

export function decodeGovId(value: string): DecodedGovId {
  const { prefix, bytes } = decodeBech32(value);

  if (bytes.length === 29) {
    const header = bytes[0] as number;
    const keyType = header >> 4;
    const credentialType = header & 0x0f;
    const role =
      (Object.keys(GOV_KEY_TYPE) as GovRole[]).find((r) => GOV_KEY_TYPE[r] === keyType) ?? null;
    return {
      role,
      format: 'cip129',
      credentialType:
        credentialType === GOV_CREDENTIAL_TYPE.scriptHash
          ? 'scriptHash'
          : credentialType === GOV_CREDENTIAL_TYPE.keyHash
            ? 'keyHash'
            : 'unknown',
      hash: toHex(bytes.subarray(1)),
    };
  }

  if (bytes.length === 28) {
    const legacyRole =
      (Object.keys(GOV_PREFIX_LEGACY_SCRIPT) as GovRole[]).find(
        (r) => GOV_PREFIX_LEGACY_SCRIPT[r] === prefix,
      ) ??
      (Object.keys(GOV_PREFIX) as GovRole[]).find((r) => GOV_PREFIX[r] === prefix) ??
      null;
    const isScriptPrefix = prefix.endsWith('_script');
    return {
      role: legacyRole,
      format: 'cip105',
      credentialType: isScriptPrefix ? 'scriptHash' : 'unknown',
      hash: toHex(bytes),
    };
  }

  throw new RangeError(
    `${prefix}: expected 28 bytes (CIP-105) or 29 bytes (CIP-129), got ${bytes.length}`,
  );
}

function concat(head: number[], ...rest: Uint8Array[]): Uint8Array {
  const total = head.length + rest.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let offset = head.length;
  for (const part of rest) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
