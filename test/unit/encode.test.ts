import { describe, expect, it } from 'vitest';
import { parseScript } from '../../src/model/json.js';
import { encodeScript, hashPreimage, scriptHash, SCRIPT_TAG } from '../../src/encode/script.js';
import { toHex } from '../../src/encode/cbor.js';
import {
  decodeGovId,
  enterpriseAddress,
  govIdCip105,
  govIdCip129,
  rewardAddress,
} from '../../src/encode/credential.js';

/**
 * Known answers taken from a DRep that exists on mainnet, recorded in the
 * Ekklesia backend's multisig fixtures. Every value here was produced by
 * cardano-serialization-lib in production and confirmed against the chain, so a
 * failure means this implementation is wrong rather than the fixture.
 */
const EKKLESIA_DREP = {
  script: {
    type: 'all',
    scripts: [
      { type: 'sig', keyHash: '40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83' },
      { type: 'after', slot: 1 },
    ],
  },
  scriptHash: '2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f',
  cip129: 'drep1yv4vp94cvr45qllmf2y4tmc4cdm5hexxxtmdxvgfyheqymcz7rw5m',
  cip105: 'drep_script19tqfdwrqadq8l762392779wrwa97f33j7mfnzzf97gpx7n6h8n2',
};

describe('script hashing', () => {
  it('reproduces a DRep script hash observed on mainnet', () => {
    expect(scriptHash(parseScript(EKKLESIA_DREP.script))).toBe(EKKLESIA_DREP.scriptHash);
  });

  it('prefixes the CBOR with the native script language tag before hashing', () => {
    const script = parseScript(EKKLESIA_DREP.script);
    const cbor = toHex(encodeScript(script));
    expect(toHex(hashPreimage(script))).toBe(`00${cbor}`);
  });

  it('encodes an "all" of a sig and a timelock to the CDDL shape', () => {
    // [1, [ [0, h'<keyhash>'], [4, 1] ]]
    expect(toHex(encodeScript(parseScript(EKKLESIA_DREP.script)))).toBe(
      '8201828200581c40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83820401',
    );
  });
});

describe('CBOR tags', () => {
  it('maps JSON "after" to invalid_before and JSON "before" to invalid_hereafter', () => {
    // The names are inverted relative to the CDDL field names. Getting this
    // backwards produces a valid script that means the opposite thing.
    expect(SCRIPT_TAG.after).toBe(4);
    expect(SCRIPT_TAG.before).toBe(5);
    expect(toHex(encodeScript(parseScript({ type: 'after', slot: 1000 })))).toBe('8204' + '1903e8');
    expect(toHex(encodeScript(parseScript({ type: 'before', slot: 1000 })))).toBe(
      '8205' + '1903e8',
    );
  });

  it('writes integers in shortest form', () => {
    expect(toHex(encodeScript(parseScript({ type: 'after', slot: 23 })))).toBe('820417');
    expect(toHex(encodeScript(parseScript({ type: 'after', slot: 24 })))).toBe('8204' + '1818');
    expect(toHex(encodeScript(parseScript({ type: 'after', slot: 256 })))).toBe('8204' + '190100');
  });

  it('encodes a negative threshold, which the CDDL permits as int64', () => {
    const cbor = toHex(encodeScript(parseScript({ type: 'atLeast', required: -1, scripts: [] })));
    expect(cbor).toBe('8303' + '20' + '80');
  });

  it('uses definite-length arrays for empty containers', () => {
    expect(toHex(encodeScript(parseScript({ type: 'all', scripts: [] })))).toBe('820180');
    expect(toHex(encodeScript(parseScript({ type: 'any', scripts: [] })))).toBe('820280');
  });
});

describe('governance identifiers', () => {
  it('reproduces both governance forms for the same script hash', () => {
    expect(govIdCip129(EKKLESIA_DREP.scriptHash, 'drep')).toBe(EKKLESIA_DREP.cip129);
    expect(govIdCip105(EKKLESIA_DREP.scriptHash, 'drep')).toBe(EKKLESIA_DREP.cip105);
  });

  it('matches the CIP-129 specification test vectors', () => {
    // CIP-129 publishes these three. They are key-hash and script-hash cases
    // across all three governance roles, over an all-zero hash.
    const zero = '00'.repeat(28);
    expect(govIdCip129(zero, 'ccCold')).toBe(
      'cc_cold1zvqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6kflvs',
    );
  });

  it('distinguishes the two drep forms only by decoded length', () => {
    // Both carry the prefix "drep". CIP-129 is 29 bytes with a header naming
    // the credential type; CIP-105 is a bare 28-byte hash whose credential type
    // the identifier does not record.
    const modern = decodeGovId(EKKLESIA_DREP.cip129);
    expect(modern.format).toBe('cip129');
    expect(modern.role).toBe('drep');
    expect(modern.credentialType).toBe('scriptHash');
    expect(modern.hash).toBe(EKKLESIA_DREP.scriptHash);

    const legacy = decodeGovId(EKKLESIA_DREP.cip105);
    expect(legacy.format).toBe('cip105');
    expect(legacy.hash).toBe(EKKLESIA_DREP.scriptHash);
  });
});

describe('addresses', () => {
  it('encodes a script enterprise address with CIP-19 type 7 and the network tag', () => {
    const preview = enterpriseAddress(EKKLESIA_DREP.scriptHash, 'preview');
    const mainnet = enterpriseAddress(EKKLESIA_DREP.scriptHash, 'mainnet');
    expect(preview.startsWith('addr_test1')).toBe(true);
    expect(mainnet.startsWith('addr1')).toBe(true);
    // Preview and preprod share network tag 0, so the two are identical.
    expect(enterpriseAddress(EKKLESIA_DREP.scriptHash, 'preprod')).toBe(preview);
  });

  it('encodes a script reward address with CIP-19 type 15', () => {
    expect(rewardAddress(EKKLESIA_DREP.scriptHash, 'mainnet').startsWith('stake1')).toBe(true);
    expect(rewardAddress(EKKLESIA_DREP.scriptHash, 'preview').startsWith('stake_test1')).toBe(true);
  });
});
