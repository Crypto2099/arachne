import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { NativeScript } from '../../src/model/types.js';
import { encodeScript, scriptHash } from '../../src/encode/script.js';
import { toHex } from '../../src/encode/cbor.js';
import { FAMILIES } from '../../src/generate/families.js';

/**
 * Arachne encodes CBOR itself rather than delegating, because the encoding is
 * the thing under test and a port has to reproduce it from a written rule. That
 * only works if the hand-rolled encoder is right, so it is checked against
 * cardano-serialization-lib, the Rust implementation that Ekklesia, Onboard
 * Ninja and most of the ecosystem already run in production.
 *
 * If these disagree, this implementation is wrong. The library wraps the same
 * code paths the wallets use.
 */
function toCsl(script: NativeScript): CSL.NativeScript {
  switch (script.type) {
    case 'sig':
      return CSL.NativeScript.new_script_pubkey(
        CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)),
      );
    case 'all':
      return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(toCslList(script.scripts)));
    case 'any':
      return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(toCslList(script.scripts)));
    case 'atLeast':
      return CSL.NativeScript.new_script_n_of_k(
        CSL.ScriptNOfK.new(script.required, toCslList(script.scripts)),
      );
    case 'after':
      return CSL.NativeScript.new_timelock_start(
        CSL.TimelockStart.new_timelockstart(CSL.BigNum.from_str(String(script.slot))),
      );
    case 'before':
      return CSL.NativeScript.new_timelock_expiry(
        CSL.TimelockExpiry.new_timelockexpiry(CSL.BigNum.from_str(String(script.slot))),
      );
  }
}

function toCslList(scripts: NativeScript[]): CSL.NativeScripts {
  const list = CSL.NativeScripts.new();
  for (const script of scripts) list.add(toCsl(script));
  return list;
}

/**
 * Every generated script, minus the cases the library cannot express. A
 * negative threshold is legal CBOR under the CDDL's `int64` but the library's
 * constructor takes an unsigned count, so it cannot be built there. That gap is
 * itself worth knowing about and is recorded in the corpus rather than hidden.
 */
const allScripts = FAMILIES.flatMap((family) =>
  family.cases().map((params) => ({
    id: `${family.name}/${family.id(params)}`,
    script: family.build(params) as NativeScript,
  })),
);

const expressible = allScripts.filter(({ script }) => !hasNegativeThreshold(script));

function hasNegativeThreshold(script: NativeScript): boolean {
  if (script.type === 'atLeast') {
    return script.required < 0 || script.scripts.some(hasNegativeThreshold);
  }
  if (script.type === 'all' || script.type === 'any')
    return script.scripts.some(hasNegativeThreshold);
  return false;
}

describe('encoder agrees with cardano-serialization-lib', () => {
  it('covers the whole generated corpus', () => {
    expect(expressible.length).toBeGreaterThan(100);
  });

  it.each(expressible.map(({ id, script }) => [id, script] as const))(
    'produces identical CBOR for %s',
    (_id, script) => {
      expect(toHex(encodeScript(script))).toBe(toHex(toCsl(script).to_bytes()));
    },
  );

  it.each(expressible.map(({ id, script }) => [id, script] as const))(
    'produces an identical script hash for %s',
    (_id, script) => {
      expect(scriptHash(script)).toBe(toCsl(script).hash().to_hex());
    },
  );

  it('cannot express a negative threshold through the library, which is why one is generated', () => {
    const negative = allScripts.filter(({ script }) => hasNegativeThreshold(script));
    expect(negative.length).toBeGreaterThan(0);
  });
});
