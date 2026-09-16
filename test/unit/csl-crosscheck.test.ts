import { describe, expect, it } from 'vitest';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { NativeScript } from '../../src/model/types.js';
import { encodeScript, scriptHash } from '../../src/encode/script.js';
import { toHex } from '../../src/encode/cbor.js';
import { FAMILIES } from '../../src/generate/families.js';
import { cosigners } from '../../src/generate/cosigners.js';

/**
 * Arachne encodes CBOR itself rather than delegating, because the encoding is
 * the thing under test and a port has to reproduce it from a written rule. That
 * only works if the hand-rolled encoder is right, so it is checked against
 * cardano-serialization-lib, the Rust implementation that Ekklesia, Onboard
 * Ninja and most of the ecosystem already run in production.
 *
 * CSL implements the `definite` encoding: every sub-script list is a
 * definite-length CBOR array whatever its size. That is NOT what cardano-node
 * produces above 23 children, so this suite deliberately pins CSL's behavior
 * rather than treating it as the single right answer. The node side is pinned
 * separately in the `cli` project. See spec/07-encoding-divergence.md.
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
  // Iterative early-exit search rather than recursion, so this also survives
  // the deep fixtures in test/unit/deep-nesting.test.ts.
  const stack: NativeScript[] = [script];
  while (stack.length > 0) {
    const node = stack.pop() as NativeScript;
    if (node.type === 'atLeast' && node.required < 0) return true;
    if (node.type === 'all' || node.type === 'any' || node.type === 'atLeast') {
      for (const child of node.scripts) stack.push(child);
    }
  }
  return false;
}

describe('encoder agrees with cardano-serialization-lib', () => {
  it('covers the whole generated corpus', () => {
    expect(expressible.length).toBeGreaterThan(100);
  });

  it.each(expressible.map(({ id, script }) => [id, script] as const))(
    'produces identical CBOR for %s',
    (_id, script) => {
      expect(toHex(encodeScript(script, 'definite'))).toBe(toHex(toCsl(script).to_bytes()));
    },
  );

  it.each(expressible.map(({ id, script }) => [id, script] as const))(
    'produces an identical script hash for %s',
    (_id, script) => {
      expect(scriptHash(script, 'definite')).toBe(toCsl(script).hash().to_hex());
    },
  );

  it('cannot express a negative threshold through the library, which is why one is generated', () => {
    const negative = allScripts.filter(({ script }) => hasNegativeThreshold(script));
    expect(negative.length).toBeGreaterThan(0);
  });
});

describe('cardano-serialization-lib diverges from the node above 23 children', () => {
  /**
   * This is the finding the project exists to surface, pinned as a test.
   *
   * CSL frames every list as a definite-length array. cardano-binary, and so
   * cardano-node and cardano-cli, switches to indefinite framing at 24. Both are
   * valid CBOR and each toolchain is self-consistent, so the same logical script
   * has two valid hashes and two valid addresses. Which one the chain holds
   * depends on which tool created it.
   *
   * If CSL ever fixes this, these assertions fail and the corpus needs
   * regenerating. That is the intended signal, not a regression.
   */
  const cohort = (n: number): NativeScript => ({
    type: 'all',
    scripts: cosigners(n).map((keyHash) => ({ type: 'sig' as const, keyHash })),
  });

  it('agrees with the node at 23 children', () => {
    const script = cohort(23);
    expect(scriptHash(script, 'definite')).toBe(scriptHash(script, 'cardanoBinary'));
    expect(toCsl(script).hash().to_hex()).toBe(scriptHash(script, 'cardanoBinary'));
  });

  it('disagrees with the node at 24 children', () => {
    const script = cohort(24);
    expect(scriptHash(script, 'definite')).not.toBe(scriptHash(script, 'cardanoBinary'));
    // CSL follows the definite encoding, so it produces the hash the node does not.
    expect(toCsl(script).hash().to_hex()).toBe(scriptHash(script, 'definite'));
    expect(toCsl(script).hash().to_hex()).not.toBe(scriptHash(script, 'cardanoBinary'));
  });

  it('writes a definite-length header where the node writes a break', () => {
    const script = cohort(24);
    // 0x98 0x18 is definite array(24); 0x9f is indefinite, closed by 0xff.
    expect(toHex(encodeScript(script, 'definite')).slice(4, 8)).toBe('9818');
    expect(toHex(encodeScript(script, 'cardanoBinary')).slice(4, 6)).toBe('9f');
    expect(toHex(encodeScript(script, 'cardanoBinary')).endsWith('ff')).toBe(true);
    expect(toHex(toCsl(script).to_bytes()).slice(4, 8)).toBe('9818');
  });
});
