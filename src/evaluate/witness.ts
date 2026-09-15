/**
 * Everything a native script is evaluated against.
 *
 * A native script sees exactly two things about a transaction: the set of
 * verification key hashes that witnessed it, and the transaction's validity
 * interval. Nothing else. No amounts, no outputs, no datum.
 *
 * Both interval bounds are optional because both are optional in a transaction
 * body, and their absence is not neutral. An unbounded transaction fails every
 * timelock in the script rather than passing it, which is the single most
 * common surprise in this area. See spec/03-satisfaction.md.
 */
export interface WitnessContext {
  /** Key hashes with a vkey witness on the transaction, lowercase hex. */
  signers: readonly string[];
  /** Transaction `invalid_before`. Absent means the transaction sets no lower bound. */
  validityStart?: number;
  /** Transaction `invalid_hereafter` (ttl). Absent means the transaction sets no upper bound. */
  validityEnd?: number;
}

export function witnessFrom(context: WitnessContext): {
  signers: ReadonlySet<string>;
  validityStart: number | undefined;
  validityEnd: number | undefined;
} {
  return {
    signers: new Set(context.signers.map((s) => s.toLowerCase())),
    validityStart: context.validityStart,
    validityEnd: context.validityEnd,
  };
}
