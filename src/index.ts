/**
 * Arachne: a harness and conformance corpus for Cardano native scripts.
 *
 * The three things it checks are independent and are meant to stay that way:
 * encoding (does an implementation produce the same CBOR and hash), satisfaction
 * (does it agree on whether a witness set satisfies a script), and ledger
 * acceptance (does a real node take it). See spec/ for the normative account.
 */
export * from './model/index.js';
export * from './encode/index.js';
export * from './evaluate/index.js';
export * from './generate/index.js';
export * from './vectors/index.js';
export type {
  ChainProvider,
  ProtocolParams,
  SubmitResult,
  Testnet,
  Utxo,
} from './chain/provider.js';
export { EXERCISE_PLANS, exceedsSizeFloor } from './chain/exercise.js';
export {
  REF_SCRIPT_LIMITS,
  refScriptFee,
  bundleBudget,
  type BundleBudget,
} from './chain/bundle.js';
