import type { CredentialRole, Vector } from '../vectors/schema.js';
import type { ChainProvider } from './provider.js';

/**
 * What it takes to prove a script works in one credential role.
 *
 * "Exercised on-chain" means something different for each role, and the
 * differences are not cosmetic. A script that spends happily as a payment
 * credential may still be refused as a DRep, because the transaction carrying
 * it is shaped differently and the witness reaches the ledger by another route.
 * Each role therefore gets its own plan and its own observation.
 */
export interface ExercisePlan {
  role: CredentialRole;
  /** The sequence of transactions needed, in order. */
  steps: string[];
  /** Deposit or funding the exercise consumes, in lovelace, excluding fees. */
  lovelaceRequired: bigint;
  /** What a rejection at each step would tell us. */
  reads: string;
}

export const EXERCISE_PLANS: Record<CredentialRole, ExercisePlan> = {
  paymentEnterprise: {
    role: 'paymentEnterprise',
    steps: [
      'fund the script enterprise address from the funding wallet',
      'spend that UTxO back in a minimal envelope, supplying the native script inline and the witness set under test',
    ],
    lovelaceRequired: 2_000_000n,
    reads:
      'Rejection on the spend is the ledger refusing the script itself, either for its size, its structure, or an unsatisfied condition.',
  },
  paymentAndStake: {
    role: 'paymentAndStake',
    steps: [
      'fund the base address whose payment and stake credentials are both the script',
      'register the stake credential',
      'spend from the address, witnessing the payment credential',
    ],
    lovelaceRequired: 4_000_000n,
    reads:
      'Separates a payment-credential failure from a stake-credential one, since the same hash sits in both slots.',
  },
  stake: {
    role: 'stake',
    steps: [
      'register the script stake credential with a registration certificate',
      'delegate to a stake pool',
      'withdraw rewards, which is the operation that actually requires the script witness',
    ],
    lovelaceRequired: 2_000_000n,
    reads:
      'Registration and delegation can succeed for a script that cannot later authorize a withdrawal, so the withdrawal is the real test.',
  },
  drep: {
    role: 'drep',
    steps: [
      'register the script as a DRep with a registration certificate and the DRep deposit',
      'cast a vote on an open governance action',
      'retire the DRep to reclaim the deposit',
    ],
    lovelaceRequired: 500_000_000n,
    reads:
      'The vote is the operation under test. Registration alone proves the credential is accepted, not that the script can authorize a vote.',
  },
  ccCold: {
    role: 'ccCold',
    steps: ['authorize a hot credential from the cold script credential'],
    lovelaceRequired: 2_000_000n,
    reads:
      'Reachable only for a committee member, so this plan runs only where the testnet has seated the credential.',
  },
  ccHot: {
    role: 'ccHot',
    steps: ['cast a committee vote using the hot script credential'],
    lovelaceRequired: 2_000_000n,
    reads: 'Same constraint as the cold credential: it needs a seated committee member.',
  },
};

/**
 * The smallest valid transaction that can carry a script, used to measure a
 * script against `maxTxSize` with as little else in the way as possible.
 *
 * `transaction_body` requires only fields 0, 1 and 2, and field 1 is
 * `[* transaction_output]`, which admits the empty list. With no outputs, value
 * is preserved when the fee equals the input balance exactly, and the fee
 * clears the minimum because it is the whole balance. So funding is one step
 * rather than a circular one: put any sufficient balance on the input and
 * declare all of it as fee.
 *
 * Validity interval fields are present only when the script has a timelock that
 * needs them, since an absent bound fails a timelock rather than passing it.
 */
export const MINIMAL_ENVELOPE = {
  description: 'one input, no outputs, entire input balance declared as the fee',
  requiredBodyFields: [0, 1, 2] as const,
  conditionalBodyFields: {
    3: 'ttl, only when the script has a "before"',
    8: 'validity interval start, only when the script has an "after"',
  },
  witnessSet: 'the script under test, plus the minimum vkey witnesses it needs',
} as const;

/**
 * A rough transaction size for the script alone, used to skip exercises that
 * cannot possibly fit before spending a submission on them.
 *
 * This counts only the script bytes, so it is a floor rather than an estimate.
 * A transaction that clears this check may still exceed `maxTxSize` once its
 * inputs, outputs and witnesses are added. It exists to avoid burning testnet
 * ADA on a script that is already over the limit by itself.
 */
export function exceedsSizeFloor(vector: Vector, maxTxSize: number): boolean {
  return vector.encoding.cborBytes >= maxTxSize;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is not implemented yet. The provider, the plans and the observation format are in place; what is missing is transaction construction. See spec/06-chain-exercises.md for the contract an implementation has to meet.`,
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * Run one exercise and return an observation.
 *
 * Transaction construction is the remaining piece. It is deliberately not
 * stubbed with a fake result: an observation that was never submitted is worse
 * than no observation, because the corpus treats observations as evidence a
 * node produced and resolves disagreements in their favor.
 */
export async function runExercise(
  _provider: ChainProvider,
  _vector: Vector,
  plan: ExercisePlan,
): Promise<never> {
  throw new NotImplementedError(`chain exercise for role "${plan.role}"`);
}
