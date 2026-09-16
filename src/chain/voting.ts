import { fromHex } from '../encode/cbor.js';
import type { ScriptHash } from '../model/types.js';
import type { TxCborWriter } from './cbor.js';

/**
 * Conway `voting_procedures`, transaction body field 19: enough to cast one
 * vote as a DRep script on an existing governance action.
 *
 * Read from `eras/conway/impl/cddl/data/conway.cddl` in
 * `IntersectMBO/cardano-ledger`:
 *
 *   voting_procedures = {+ voter => {+ gov_action_id => voting_procedure}}
 *   voter =
 *     [  0, addr_keyhash    // 1, script_hash
 *     // 2, addr_keyhash    // 3, script_hash
 *     // 4, addr_keyhash ]
 *   gov_action_id = [transaction_id : transaction_id, gov_action_index : uint .size 2]
 *   voting_procedure = [vote, anchor/ nil]
 *   vote = 0 .. 2
 *
 * `voter`'s indices are not in the order a reader would guess. 0 and 1 are a
 * constitutional committee hot credential, key then script; 2 and 3 are a
 * DRep credential, key then script; 4 is a stake pool operator, which has no
 * script alternative because a pool's identity is always a key hash. A DRep
 * casting a vote as a script is index 3, not 1 or 2. Getting this wrong
 * produces a well-formed transaction that votes as a different kind of
 * entity than intended.
 *
 * The CDDL states only `vote = 0 .. 2` with no comment on which value means
 * what. Checked empirically against `cardano-cli conway governance vote
 * create`: `--no` writes 0, `--yes` writes 1, `--abstain` writes 2.
 *
 * `voting_procedures` is a plain CBOR map, `{+ a0 => a1}`, not a `set<a0>`:
 * unlike `certificates` (a `nonempty_oset`, tag 258 over an array), it
 * carries no tag. Confirmed by inspecting the `cborHex` cardano-cli writes
 * for `--vote-file` in `transaction build-raw`: transaction body field 19
 * is a bare map header, `a1...`, with no `d90102` tag ahead of it.
 *
 * `anchor` is always written as `nil` here, the same default `cardano-cli`
 * uses when no `--anchor-url` is given, since none of the exercises this
 * module supports need one.
 */

const HASH28_LENGTH = 28;
const HASH32_LENGTH = 32;

function checkHash(hex: string, label: string, length: number): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== length) {
    throw new RangeError(`${label} is ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export type Voter =
  /** `voter` index 0: constitutional committee hot credential, key. */
  | { kind: 'ccHotKey'; keyHash: string }
  /** `voter` index 1: constitutional committee hot credential, script. */
  | { kind: 'ccHotScript'; scriptHash: ScriptHash }
  /** `voter` index 2: DRep credential, key. */
  | { kind: 'drepKey'; keyHash: string }
  /** `voter` index 3: DRep credential, script. This is the alternative a DRep script exercise votes as. */
  | { kind: 'drepScript'; scriptHash: ScriptHash }
  /** `voter` index 4: stake pool operator. No script alternative exists; a pool's identity is always a key hash. */
  | { kind: 'stakePoolKey'; keyHash: string };

const VOTER_INDEX: Record<Voter['kind'], number> = {
  ccHotKey: 0,
  ccHotScript: 1,
  drepKey: 2,
  drepScript: 3,
  stakePoolKey: 4,
};

function voterHash(voter: Voter): string {
  return 'scriptHash' in voter ? voter.scriptHash : voter.keyHash;
}

function writeVoter(writer: TxCborWriter, voter: Voter): void {
  const hash = checkHash(
    voterHash(voter),
    `a voter credential hash (${voter.kind})`,
    HASH28_LENGTH,
  );
  writer.arrayHeader(2).uint(VOTER_INDEX[voter.kind]).bytes(hash);
}

export interface GovActionId {
  /** Lowercase hex, 32 bytes: the id of the transaction whose proposal procedures carried this action. */
  transactionId: string;
  /** `uint .size 2`: the action's index within that transaction's proposal procedures. */
  actionIndex: number;
}

function writeGovActionId(writer: TxCborWriter, id: GovActionId): void {
  const txId = checkHash(id.transactionId, 'a governance action transaction id', HASH32_LENGTH);
  writer.arrayHeader(2).bytes(txId).uint(id.actionIndex);
}

export type VoteChoice = 'no' | 'yes' | 'abstain';

/** `vote = 0 .. 2`. Order confirmed against `cardano-cli conway governance vote create`; see the module comment. */
const VOTE_CODE: Record<VoteChoice, number> = { no: 0, yes: 1, abstain: 2 };

/** One entry of `voting_procedures`: a voter casting a choice on one governance action. */
export interface VoteCast {
  voter: Voter;
  actionId: GovActionId;
  choice: VoteChoice;
}

/**
 * Write `voting_procedures = {+ voter => {+ gov_action_id => voting_procedure}}`.
 *
 * Votes are grouped into the nested-map shape the CDDL requires, in the
 * order they were given rather than any canonical one: `cardano-cli`'s own
 * decoder does not require sorted map keys, and every case this builder
 * produces carries exactly one voter and one action.
 */
export function writeVotingProcedures(writer: TxCborWriter, votes: readonly VoteCast[]): void {
  if (votes.length === 0) {
    throw new RangeError('voting_procedures is never written empty; omit the map key instead');
  }

  const voterOrder: string[] = [];
  const byVoter = new Map<string, { voter: Voter; actions: Map<string, VoteCast> }>();
  for (const cast of votes) {
    const voterKey = `${cast.voter.kind}:${voterHash(cast.voter)}`;
    let entry = byVoter.get(voterKey);
    if (!entry) {
      entry = { voter: cast.voter, actions: new Map() };
      byVoter.set(voterKey, entry);
      voterOrder.push(voterKey);
    }
    entry.actions.set(`${cast.actionId.transactionId}:${cast.actionId.actionIndex}`, cast);
  }

  writer.mapHeader(voterOrder.length);
  for (const voterKey of voterOrder) {
    const entry = byVoter.get(voterKey);
    if (!entry) throw new Error('unreachable: voterKey was just inserted');
    writeVoter(writer, entry.voter);
    writer.mapHeader(entry.actions.size);
    for (const cast of entry.actions.values()) {
      writeGovActionId(writer, cast.actionId);
      // voting_procedure = [vote, anchor/ nil]
      writer.arrayHeader(2).uint(VOTE_CODE[cast.choice]).null();
    }
  }
}
