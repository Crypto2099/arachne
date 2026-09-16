import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseScript } from '../../../src/model/json.js';
import { scriptHash } from '../../../src/encode/script.js';
import { toHex } from '../../../src/encode/cbor.js';
import { TxCborWriter } from '../../../src/chain/cbor.js';
import { writeVotingProcedures, type VoteCast } from '../../../src/chain/voting.js';
import { CardanoCliOracle, cardanoCliAvailable } from './support/cardano-cli.js';

const SCRIPT_HASH = '11'.repeat(28);
const TX_ID = '22'.repeat(32);

function encode(votes: VoteCast[]): string {
  const writer = new TxCborWriter();
  writeVotingProcedures(writer, votes);
  return toHex(writer.toBytes());
}

describe('voter index, hand-verified against the CDDL production directly', () => {
  // voter =
  //   [  0, addr_keyhash    // 1, script_hash
  //   // 2, addr_keyhash    // 3, script_hash
  //   // 4, addr_keyhash ]
  //
  // The indices are not in the order a reader would guess: a DRep script is
  // index 3, and index 1 is a constitutional committee hot script, not a
  // DRep. This test pins both so the two cannot be swapped by accident.
  const actionId = { transactionId: TX_ID, actionIndex: 0 };

  it('a DRep script voter is voter index 3, not 1', () => {
    const bytes = encode([
      { voter: { kind: 'drepScript', scriptHash: SCRIPT_HASH }, actionId, choice: 'yes' },
    ]);
    // {1 => {gov_action_id => ...}}: map(1), key = voter [3, script_hash].
    expect(bytes.startsWith('a1' + '8203' + '581c' + SCRIPT_HASH)).toBe(true);
  });

  it('a constitutional committee hot script voter is voter index 1, distinct from a DRep script', () => {
    const bytes = encode([
      { voter: { kind: 'ccHotScript', scriptHash: SCRIPT_HASH }, actionId, choice: 'yes' },
    ]);
    expect(bytes.startsWith('a1' + '8201' + '581c' + SCRIPT_HASH)).toBe(true);
  });

  it('a stake pool operator voter is voter index 4 and carries a key hash, never a script', () => {
    const bytes = encode([
      { voter: { kind: 'stakePoolKey', keyHash: SCRIPT_HASH }, actionId, choice: 'no' },
    ]);
    expect(bytes.startsWith('a1' + '8204' + '581c' + SCRIPT_HASH)).toBe(true);
  });
});

describe('vote encoding, hand-verified against the CDDL production directly', () => {
  const voter = { kind: 'drepScript' as const, scriptHash: SCRIPT_HASH };
  const actionId = { transactionId: TX_ID, actionIndex: 5 };

  it('voting_procedures = {+ voter => {+ gov_action_id => voting_procedure}}, a plain map with no set tag', () => {
    const bytes = encode([{ voter, actionId, choice: 'yes' }]);
    // gov_action_id = [transaction_id, gov_action_index] = 8258... 05
    // voting_procedure = [vote, anchor/ nil] = 8201f6 for "yes"
    expect(bytes).toBe(
      'a1' + // map(1): one voter
        '8203' +
        '581c' +
        SCRIPT_HASH + // voter: [3, script_hash]
        'a1' + // map(1): one action
        '8258' +
        '20' +
        TX_ID +
        '05' + // gov_action_id
        '8201f6', // voting_procedure: [1 (yes), null]
    );
  });

  it('rejects an empty vote list rather than writing an empty map', () => {
    expect(() => encode([])).toThrow(RangeError);
  });

  it('rejects a hash of the wrong length', () => {
    expect(() =>
      encode([
        {
          voter: { kind: 'drepScript', scriptHash: SCRIPT_HASH.slice(2) },
          actionId,
          choice: 'yes',
        },
      ]),
    ).toThrow(RangeError);
  });
});

const cliAvailable = cardanoCliAvailable();
const describeCli = cliAvailable ? describe : describe.skip;
if (!cliAvailable) {
  console.warn('cardano-cli not on PATH, skipping the voting cross-check tests');
}

describeCli('cross-checked against cardano-cli', () => {
  let oracle: CardanoCliOracle;

  beforeEach(() => {
    oracle = new CardanoCliOracle();
  });

  afterEach(() => {
    oracle.dispose();
  });

  function throwawayDrepScriptHash(): string {
    const generated = oracle.generateKey();
    const script = parseScript({ type: 'sig', keyHash: generated.keyHash });
    return scriptHash(script);
  }

  it.each([
    ['yes', 'yes'],
    ['no', 'no'],
    ['abstain', 'abstain'],
  ] as const)(
    'matches cardano-cli for a DRep script vote (%s), confirming vote = 0..2 codes the choice in that order',
    (cliFlag, choice) => {
      const hash = throwawayDrepScriptHash();
      const actionId = { transactionId: TX_ID, actionIndex: 0 };
      const cli = oracle.voteCreate(cliFlag, hash, actionId.transactionId, actionId.actionIndex);
      const built = encode([{ voter: { kind: 'drepScript', scriptHash: hash }, actionId, choice }]);
      expect(built).toBe(cli.cborHex);
    },
  );
});
