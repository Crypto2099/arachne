import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseScript } from '../../../src/model/json.js';
import { scriptHash } from '../../../src/encode/script.js';
import { toHex } from '../../../src/encode/cbor.js';
import { TxCborWriter } from '../../../src/chain/cbor.js';
import { writeCertificate, type Certificate } from '../../../src/chain/certificates.js';
import { CardanoCliOracle, cardanoCliAvailable } from './support/cardano-cli.js';

/** A fixed 28-byte hash, standing in for a script hash with no script behind it. */
const HASH = '11'.repeat(28);

function encode(cert: Certificate): string {
  const writer = new TxCborWriter();
  writeCertificate(writer, cert);
  return toHex(writer.toBytes());
}

describe('certificate encoding, hand-verified against the CDDL production directly', () => {
  // credential = [0, addr_keyhash// 1, script_hash]; every certificate below
  // uses the script alternative, so every credential is `8201581c<hash>`:
  // array(2), uint(1), bytes(28).
  const credential = '8201581c' + HASH;

  it('account_registration_cert = (0, stake_credential): no cardano-cli equivalent in conway, see src/chain/certificates.ts', () => {
    expect(encode({ kind: 'stakeRegistration', stakeScriptHash: HASH })).toBe(
      '82' + '00' + credential,
    );
  });

  it('account_unregistration_cert = (1, stake_credential): no cardano-cli equivalent in conway, see src/chain/certificates.ts', () => {
    expect(encode({ kind: 'stakeUnregistration', stakeScriptHash: HASH })).toBe(
      '82' + '01' + credential,
    );
  });

  it('rejects a script hash or pool key hash that is not 28 bytes', () => {
    expect(() => encode({ kind: 'stakeRegistration', stakeScriptHash: HASH.slice(2) })).toThrow(
      RangeError,
    );
    expect(() =>
      encode({ kind: 'stakeDelegation', stakeScriptHash: HASH, poolKeyHash: '00' }),
    ).toThrow(RangeError);
  });
});

const cliAvailable = cardanoCliAvailable();
const describeCli = cliAvailable ? describe : describe.skip;
if (!cliAvailable) {
  console.warn('cardano-cli not on PATH, skipping the certificate cross-check tests');
}

describeCli('cross-checked against cardano-cli', () => {
  let oracle: CardanoCliOracle;

  beforeEach(() => {
    oracle = new CardanoCliOracle();
  });

  afterEach(() => {
    oracle.dispose();
  });

  function throwawayScript() {
    const generated = oracle.generateKey();
    const script = parseScript({ type: 'sig', keyHash: generated.keyHash });
    const scriptPath = oracle.scriptFile(script);
    const hash = scriptHash(script);
    return { scriptPath, hash };
  }

  it('matches cardano-cli for stake credential registration with a deposit (account_registration_deposit_cert, alt 7)', () => {
    const { scriptPath, hash } = throwawayScript();
    const deposit = 2_000_000n;
    const cli = oracle.stakeRegistrationCertificate(scriptPath, deposit);
    const built = encode({ kind: 'stakeRegistrationWithDeposit', stakeScriptHash: hash, deposit });
    expect(built).toBe(cli.cborHex);
  });

  it('matches cardano-cli for stake credential unregistration with a deposit (account_unregistration_deposit_cert, alt 8)', () => {
    const { scriptPath, hash } = throwawayScript();
    const deposit = 2_000_000n;
    const cli = oracle.stakeDeregistrationCertificate(scriptPath, deposit);
    const built = encode({
      kind: 'stakeUnregistrationWithDeposit',
      stakeScriptHash: hash,
      deposit,
    });
    expect(built).toBe(cli.cborHex);
  });

  it('matches cardano-cli for delegation to a stake pool (delegation_to_stake_pool_cert, alt 2)', () => {
    const { scriptPath, hash } = throwawayScript();
    const poolIdHex = oracle.generatePoolIdHex();
    const cli = oracle.stakeDelegationCertificate(scriptPath, poolIdHex);
    const built = encode({
      kind: 'stakeDelegation',
      stakeScriptHash: hash,
      poolKeyHash: poolIdHex,
    });
    expect(built).toBe(cli.cborHex);
  });

  it('matches cardano-cli for DRep registration (drep_registration_cert, alt 16)', () => {
    const { hash } = throwawayScript();
    const deposit = 500_000_000n;
    const cli = oracle.drepRegistrationCertificate(hash, deposit);
    const built = encode({ kind: 'drepRegistration', drepScriptHash: hash, deposit });
    expect(built).toBe(cli.cborHex);
  });

  it('matches cardano-cli for DRep unregistration, which the CLI calls "retirement" (drep_unregistration_cert, alt 17)', () => {
    const { hash } = throwawayScript();
    const deposit = 500_000_000n;
    const cli = oracle.drepRetirementCertificate(hash, deposit);
    const built = encode({ kind: 'drepUnregistration', drepScriptHash: hash, deposit });
    expect(built).toBe(cli.cborHex);
  });

  it('matches cardano-cli for DRep update (drep_update_cert, alt 18)', () => {
    const { hash } = throwawayScript();
    const cli = oracle.drepUpdateCertificate(hash);
    const built = encode({ kind: 'drepUpdate', drepScriptHash: hash });
    expect(built).toBe(cli.cborHex);
  });
});
