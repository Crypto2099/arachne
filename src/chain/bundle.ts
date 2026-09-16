import type { Vector } from '../vectors/schema.js';

/**
 * Conway's limits on scripts delivered as reference scripts. These are fixed in
 * the era rather than settable by a protocol parameter update, and are read
 * from `ppMaxRefScriptSizePerTxG` and its neighbors in the Conway PParams
 * module of the ledger.
 */
/**
 * Conway fixes these in the era rather than exposing them as updatable protocol
 * parameters, so they cannot be read from a node's parameter set. That makes
 * them constants only for as long as Conway is the era: a later era can choose
 * differently, and these values then need rechecking against its own PParams
 * module rather than being trusted.
 */
export const REF_SCRIPT_LIMITS = {
  maxPerTx: 200 * 1024,
  maxPerBlock: 1024 * 1024,
  /** Bytes per tier. The price steps up at each stride. */
  stride: 25_600,
  /** Growth factor applied to the price at each tier. 1.2 as a fraction. */
  multiplierNum: 6n,
  multiplierDen: 5n,
} as const;

/**
 * `minFeeRefScriptCostPerByte` as it stood on preprod and mainnet in epoch 313.
 *
 * This is a PROTOCOL PARAMETER and governance can change it, so it is a
 * last-resort fallback rather than a constant to rely on. Anything talking to a
 * live chain should read the value from that chain and pass it in;
 * `ChainProvider.protocolParams` returns it.
 */
export const FALLBACK_REF_SCRIPT_COST_PER_BYTE = 15n;

/**
 * The reference script fee, in lovelace.
 *
 * The price per byte grows geometrically in linear increments: the first
 * `stride` bytes cost `costPerByte` each, the next `stride` cost
 * `costPerByte * multiplier`, and so on. The floor is applied once at the end
 * over the accumulated total, not per tier, so this is computed in exact
 * rational arithmetic rather than floating point.
 *
 * Transcribed from `tierRefScriptFee` in the ledger's Conway Tx module. Note
 * that the tier boundary is strict: a size of exactly one stride advances to
 * the next tier.
 */
export function refScriptFee(
  sizeBytes: number,
  costPerByte: bigint = FALLBACK_REF_SCRIPT_COST_PER_BYTE,
): bigint {
  const { stride, multiplierNum, multiplierDen } = REF_SCRIPT_LIMITS;

  let accNum = 0n;
  let accDen = 1n;
  let priceNum = costPerByte;
  let priceDen = 1n;
  let remaining = sizeBytes;

  while (remaining >= stride) {
    // acc += stride * price
    accNum = accNum * priceDen + BigInt(stride) * priceNum * accDen;
    accDen = accDen * priceDen;
    priceNum *= multiplierNum;
    priceDen *= multiplierDen;
    remaining -= stride;
  }

  // floor(acc + remaining * price)
  const totalNum = accNum * priceDen + BigInt(remaining) * priceNum * accDen;
  const totalDen = accDen * priceDen;
  return totalNum / totalDen;
}

export interface BundleBudget {
  scriptCount: number;
  totalScriptBytes: number;
  /** Fits in one transaction with the scripts carried inline. */
  fitsInline: boolean;
  /** Within the per-transaction reference script budget. */
  fitsAsReferenceScripts: boolean;
  /** Reference script fee in lovelace, when taking that route. */
  referenceScriptFee: bigint;
  /** The largest single script, which is what bounds the creating transaction. */
  largestScriptBytes: number;
  /** A script too large to be created in the first place, by either route. */
  uncreatableScripts: string[];
  notes: string[];
}

/**
 * Whether a set of scripts can travel in one transaction, and by which route.
 *
 * This is the question a federation raises. A single script is bounded by
 * `maxTxSize` whichever way it is delivered, because a reference script has to
 * be created before it can be referenced and the creating transaction carries
 * it in an output. What the 200 KiB reference budget buys is MANY scripts in one
 * transaction, not one larger script, and that is exactly what a transaction
 * where several large multisigs interact needs.
 */
export function bundleBudget(
  vectors: Vector[],
  maxTxSize: number,
  envelopeBytes = 0,
  costPerByte: bigint = FALLBACK_REF_SCRIPT_COST_PER_BYTE,
): BundleBudget {
  // The node-side encoding, since this arithmetic is about what a node accepts.
  const sizes = vectors.map((v) => v.encoding.cardanoBinary.cborBytes);
  const totalScriptBytes = sizes.reduce((n, s) => n + s, 0);
  const largestScriptBytes = sizes.length > 0 ? Math.max(...sizes) : 0;

  // A reference script sits inside a transaction output, so creating one costs
  // its own bytes plus that transaction's envelope.
  const uncreatableScripts = vectors
    .filter((v) => v.encoding.cardanoBinary.cborBytes + envelopeBytes > maxTxSize)
    .map((v) => v.id);

  const notes: string[] = [];
  if (uncreatableScripts.length > 0) {
    notes.push(
      `${uncreatableScripts.length} script(s) exceed maxTxSize on their own, so no route can deliver them.`,
    );
  }
  if (
    totalScriptBytes + envelopeBytes > maxTxSize &&
    totalScriptBytes <= REF_SCRIPT_LIMITS.maxPerTx
  ) {
    notes.push(
      'Too large to carry inline, within the reference script budget. Create each script in its own transaction first, then reference them.',
    );
  }
  if (totalScriptBytes > REF_SCRIPT_LIMITS.maxPerTx) {
    notes.push(
      `Total ${totalScriptBytes} bytes exceeds maxRefScriptSizePerTx of ${REF_SCRIPT_LIMITS.maxPerTx}. The ledger counts non-distinct size, so referencing one script twice counts it twice.`,
    );
  }

  return {
    scriptCount: vectors.length,
    totalScriptBytes,
    fitsInline: totalScriptBytes + envelopeBytes <= maxTxSize,
    fitsAsReferenceScripts:
      totalScriptBytes <= REF_SCRIPT_LIMITS.maxPerTx && uncreatableScripts.length === 0,
    referenceScriptFee: refScriptFee(totalScriptBytes, costPerByte),
    largestScriptBytes,
    uncreatableScripts,
    notes,
  };
}
