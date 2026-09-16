/**
 * Script size ceilings, derived from protocol parameters rather than stated.
 *
 * Every limit this project has measured is a consequence of `maxTxSize`, which
 * is a protocol parameter and can be raised or lowered by governance action. A
 * library that bakes in today's value tells its users the wrong thing the day it
 * changes, and worse, tells them confidently. So the ceilings are functions.
 *
 * The byte costs below are measured from transactions accepted on preprod, not
 * estimated. They are properties of the CBOR encoding rather than of the
 * protocol, so they do not move with a parameter change: a signature is 64 bytes
 * because ed25519 says so.
 */

/** An array header, a 32-byte vkey with its header, a 64-byte signature with its header. */
export const VKEY_WITNESS_BYTES = 101;

/** `[0, h'<28 bytes>']`: array header, tag, byte-string header, hash. */
export const SIG_ENTRY_BYTES = 32;

/** `82 01 81`: one `all` wrapping exactly one child. */
export const NEST_WRAPPER_BYTES = 3;

/**
 * Everything a minimal spending transaction carries besides its script and its
 * signatures: one input, one output, the fee, the CBOR frames, and the tag 258
 * every Conway set carries.
 *
 * Measured, not derived. A depth-5383 spend came to 16,383 bytes against a
 * 16,181-byte script and one 101-byte witness, leaving 101; the multisig runs
 * agree within a byte or two depending on the fee's own width. 102 is the value
 * that reproduces both, and it is deliberately not rounded down, because a
 * ceiling that is one byte optimistic is a transaction that does not fit.
 */
export const SPEND_ENVELOPE_BYTES = 102;

/** Bytes left for a script once the envelope and `signers` witnesses are paid for. */
export function scriptBudget(maxTxSize: number, signers: number): number {
  return maxTxSize - SPEND_ENVELOPE_BYTES - signers * VKEY_WITNESS_BYTES;
}

/**
 * The deepest a single key can be wrapped in `all` and still be spent inline.
 *
 * At `maxTxSize` 16,384 this is 5,383, which was accepted on preprod while 5,384
 * was refused for size. It is not `(maxTxSize - 32) / 3`: that counts only the
 * script and ignores the transaction around it.
 */
export function maxLinearNestDepth(maxTxSize: number): number {
  return Math.floor((scriptBudget(maxTxSize, 1) - SIG_ENTRY_BYTES) / NEST_WRAPPER_BYTES);
}

/**
 * The largest unanimous n-of-n whose spend fits with the script carried inline.
 *
 * Each member costs a signature entry in the script AND a witness in the
 * transaction, so members are expensive here in a way they are not under a low
 * threshold. At `maxTxSize` 16,384 this is 122, confirmed on preprod, with 123
 * refused for size.
 */
export function maxUnanimousInline(maxTxSize: number): number {
  // n * (SIG_ENTRY + VKEY_WITNESS) + threshold header <= maxTxSize - envelope.
  // The threshold header is 4 or 5 bytes depending on how wide n's own CBOR is.
  for (let n = Math.floor(maxTxSize / (SIG_ENTRY_BYTES + VKEY_WITNESS_BYTES)) + 2; n > 0; n -= 1) {
    if (unanimousInlineSize(n) <= maxTxSize) return n;
  }
  return 0;
}

/**
 * The largest unanimous n-of-n when the script is delivered by reference input,
 * so only the witnesses travel with the spend.
 *
 * At `maxTxSize` 16,384 this is 160, confirmed on preprod, with 161 refused.
 * Past that the signatures alone exceed the limit and no delivery route helps.
 */
export function maxUnanimousByReference(maxTxSize: number): number {
  // A reference input costs about 38 bytes on top of the ordinary envelope.
  const budget = maxTxSize - SPEND_ENVELOPE_BYTES - 38;
  return Math.floor(budget / VKEY_WITNESS_BYTES);
}

function cborHeaderBytes(n: number): number {
  if (n < 24) return 1;
  if (n <= 0xff) return 2;
  if (n <= 0xffff) return 3;
  return 5;
}

function unanimousInlineSize(n: number): number {
  const script = 2 + cborHeaderBytes(n) + cborHeaderBytes(n) + n * SIG_ENTRY_BYTES;
  return SPEND_ENVELOPE_BYTES + n * VKEY_WITNESS_BYTES + script;
}
