import { describe, expect, it } from 'vitest';
import {
  TransactionReadError,
  nativeScriptsIn,
  outputNativeScripts,
  referenceScriptIn,
  skipItem,
  transactionBodyBytes,
  witnessNativeScripts,
} from '../../../src/chain/scripts.js';
import { TxCborWriter } from '../../../src/chain/cbor.js';
import { transactionId } from '../../../src/chain/transaction.js';
import { encodeScript } from '../../../src/encode/script.js';
import { parseScript } from '../../../src/model/json.js';
import { fromHex, toHex } from '../../../src/encode/cbor.js';

/**
 * Reading a script back out of a transaction, which is how a script arrives
 * from anywhere real.
 *
 * Two lines of the Conway CDDL are why this needs tests rather than being
 * obvious. `nonempty_list<a0> = #6.258([+ a0])/ [+ a0]` makes the set tag
 * optional, so a witness set's script list is tagged in some conforming
 * transactions and bare in others, and reading the tag's head as the array's
 * head yields a list of 258 items. `transaction_output = alonzo_transaction_output/
 * babbage_transaction_output` is a choice between an array and a map, and only
 * the map has a `script_ref` field at all.
 */
const SCRIPT = encodeScript(parseScript({ type: 'all', scripts: [] }), 'definite');
const KEY = 'aa'.repeat(28);
const SIG = encodeScript(parseScript({ type: 'sig', keyHash: KEY }), 'definite');

/** A minimal `[body, witness_set, true, null]` around a caller-supplied body and witness set. */
function transaction(body: Uint8Array, witnessSet: Uint8Array): Uint8Array {
  return new TxCborWriter().arrayHeader(4).raw(body).raw(witnessSet).true().null().toBytes();
}

/** The smallest body this reader cares about: one output, of the given bytes. */
function bodyWithOutputs(outputs: Uint8Array[]): Uint8Array {
  const w = new TxCborWriter().mapHeader(1).uint(1).arrayHeader(outputs.length);
  for (const output of outputs) w.raw(output);
  return w.toBytes();
}

/** `babbage_transaction_output` holding a `script_ref = #6.24(bytes .cbor script)`. */
function outputWithScriptRef(scriptType: number, script: Uint8Array): Uint8Array {
  const wrapped = new TxCborWriter().arrayHeader(2).uint(scriptType).raw(script).toBytes();
  return new TxCborWriter()
    .mapHeader(2)
    .uint(0)
    .bytes(fromHex('00'.repeat(29)))
    .uint(3)
    .tag(24)
    .bytes(wrapped)
    .toBytes();
}

describe('the witness set script list, tagged or bare', () => {
  // Both forms are conforming, so both have to be read. A transaction from
  // cardano-cli carries the tag; the grammar does not require it.
  const witnessSetWith = (tagged: boolean): Uint8Array => {
    const w = new TxCborWriter().mapHeader(1).uint(1);
    if (tagged) w.tag(258);
    return w.arrayHeader(2).raw(SCRIPT).raw(SIG).toBytes();
  };

  it('reads a list wrapped in the set tag', () => {
    const tx = transaction(bodyWithOutputs([]), witnessSetWith(true));
    expect(witnessNativeScripts(tx)).toEqual([toHex(SCRIPT), toHex(SIG)]);
  });

  it('reads a bare list the same way', () => {
    const tx = transaction(bodyWithOutputs([]), witnessSetWith(false));
    expect(witnessNativeScripts(tx)).toEqual([toHex(SCRIPT), toHex(SIG)]);
  });

  it('returns nothing when the witness set has no script list', () => {
    const empty = new TxCborWriter().mapHeader(0).toBytes();
    expect(witnessNativeScripts(transaction(bodyWithOutputs([]), empty))).toEqual([]);
  });
});

describe('script_ref in an output', () => {
  const witnessSet = new TxCborWriter().mapHeader(0).toBytes();

  it('reads a native script back as the exact bytes it was stored as', () => {
    const tx = transaction(bodyWithOutputs([outputWithScriptRef(0, SCRIPT)]), witnessSet);
    expect(referenceScriptIn(tx, 0)).toBe(toHex(SCRIPT));
    expect(outputNativeScripts(tx)).toEqual([{ outputIndex: 0, cborHex: toHex(SCRIPT) }]);
  });

  it('ignores a Plutus script, which is not a native one', () => {
    // script = [0, native_script // 1, plutus_v1_script // ...]: only tag 0.
    const tx = transaction(bodyWithOutputs([outputWithScriptRef(1, SCRIPT)]), witnessSet);
    expect(referenceScriptIn(tx, 0)).toBeUndefined();
    expect(outputNativeScripts(tx)).toEqual([]);
  });

  it('reads an alonzo array output as carrying no script', () => {
    // `alonzo_transaction_output = [address, amount, ? datum_hash]` has no
    // script_ref field, so it is told apart by major type before any lookup.
    const legacy = new TxCborWriter()
      .arrayHeader(2)
      .bytes(fromHex('00'.repeat(29)))
      .uint(1_000_000)
      .toBytes();
    const tx = transaction(bodyWithOutputs([legacy]), witnessSet);
    expect(referenceScriptIn(tx, 0)).toBeUndefined();
  });

  it('reports an output index the transaction does not have', () => {
    const tx = transaction(bodyWithOutputs([outputWithScriptRef(0, SCRIPT)]), witnessSet);
    expect(() => referenceScriptIn(tx, 3)).toThrow(TransactionReadError);
    expect(() => referenceScriptIn(tx, 3)).toThrow(/past the 1 outputs/);
  });

  it('finds only the outputs that carry one', () => {
    const plain = new TxCborWriter()
      .mapHeader(1)
      .uint(0)
      .bytes(fromHex('00'.repeat(29)))
      .toBytes();
    const tx = transaction(
      bodyWithOutputs([plain, outputWithScriptRef(0, SIG), plain]),
      witnessSet,
    );
    expect(outputNativeScripts(tx)).toEqual([{ outputIndex: 1, cborHex: toHex(SIG) }]);
  });
});

describe('the transaction body', () => {
  it('is returned as the slice the transaction id is taken over', () => {
    const body = bodyWithOutputs([]);
    const tx = transaction(body, new TxCborWriter().mapHeader(0).toBytes());
    expect(toHex(transactionBodyBytes(tx))).toBe(toHex(body));
    expect(transactionId(transactionBodyBytes(tx))).toBe(transactionId(body));
  });

  it('refuses bytes that are not a transaction array', () => {
    expect(() => transactionBodyBytes(fromHex('a0'))).toThrow(/not an array/);
  });
});

describe('depth', () => {
  it('walks past a script deep enough to overflow a recursive reader', () => {
    // The chain has already accepted 5,383 wrappers on preprod. This is
    // deeper, so the explicit work stack is doing the work and not the
    // call stack; see test/unit/deep-nesting.test.ts for the same property
    // across the rest of the library.
    const depth = 20_000;
    const w = new TxCborWriter();
    for (let i = 0; i < depth; i += 1) w.arrayHeader(2).uint(1).arrayHeader(1);
    w.raw(SIG);
    const deep = w.toBytes();

    expect(skipItem(deep, 0)).toBe(deep.length);

    const witnessSet = new TxCborWriter().mapHeader(1).uint(1).tag(258).arrayHeader(1).raw(deep);
    const tx = transaction(bodyWithOutputs([]), witnessSet.toBytes());
    expect(nativeScriptsIn(tx)).toEqual([{ location: 'witness', cborHex: toHex(deep) }]);
  });
});

describe('malformed input', () => {
  it('reports a truncated argument rather than reading past the end', () => {
    expect(() => skipItem(fromHex('1a0000'), 0)).toThrow(TransactionReadError);
  });

  it('reports an unterminated indefinite array', () => {
    expect(() => skipItem(fromHex('9f0102'), 0)).toThrow(/unterminated/);
  });

  it('rejects reserved additional information', () => {
    expect(() => skipItem(fromHex('1c'), 0)).toThrow(/reserved additional information 28/);
  });
});
