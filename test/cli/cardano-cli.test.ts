import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { parseScript } from '../../src/model/json.js';
import type { NativeScript } from '../../src/model/types.js';
import { loadAllVectors } from '../../src/vectors/load.js';
import type { Vector } from '../../src/vectors/schema.js';
import { CliSession, cardanoCliAvailable, cliVersion } from '../../src/vectors/cardano-cli.js';
import {
  baseAddressScriptStake,
  enterpriseAddress,
  rewardAddress,
} from '../../src/encode/credential.js';

/**
 * Cross-check against cardano-cli, the Haskell tool that shares cardano-api's
 * serialization path with the node.
 *
 * This is a stronger oracle than cardano-serialization-lib. CSL is an
 * independent Rust implementation, so agreeing with it means two implementations
 * concur; agreeing with cardano-cli means agreeing with the code the node
 * itself is built from. Passing both is worth more than passing either.
 *
 * The binary is not a dependency, so the whole suite skips when it is absent.
 */
const available = cardanoCliAvailable();
const describeCli = available ? describe : describe.skip;

if (!available) {
  console.warn('cardano-cli not on PATH, skipping the cli conformance project');
}

/**
 * cardano-cli validates more than the ledger does. Its JSON reader rejects a
 * threshold larger than the number of sub-scripts, which is a well-formed
 * script the ledger accepts and evaluates as permanently unsatisfiable.
 *
 * It does NOT reject a negative threshold, so the validation is one-sided.
 * These vectors therefore cannot be built with cardano-cli at all, and the
 * suite asserts the refusal rather than skipping it, so a change in either
 * direction shows up as a test failure.
 */
function cliRefuses(script: NativeScript): boolean {
  if (script.type === 'atLeast') {
    if (script.required > script.scripts.length) return true;
    return script.scripts.some(cliRefuses);
  }
  if (script.type === 'all' || script.type === 'any') return script.scripts.some(cliRefuses);
  return false;
}

let cli: CliSession;

beforeAll(() => {
  if (available) cli = new CliSession();
});

afterAll(() => {
  cli?.dispose();
});

describeCli('cardano-cli agrees on the script hash', () => {
  it('reports the version it checked against', () => {
    const version = cliVersion();
    expect(version).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(`cross-checked against ${version?.raw}`);
  });

  it('reproduces every hash it will build', async () => {
    const vectors = await loadAllVectors();
    const disagreements: string[] = [];
    const refused: string[] = [];

    for (const vector of vectors) {
      const script = parseScript(vector.script);
      const outcome = cli.scriptHash(script);

      if (outcome.status === 'refused') {
        refused.push(vector.id);
        // A refusal is only acceptable where we predicted it.
        if (!cliRefuses(script)) {
          disagreements.push(`${vector.id}: unexpected refusal, ${outcome.error}`);
        }
        continue;
      }

      if (cliRefuses(script)) {
        disagreements.push(`${vector.id}: expected a refusal, cardano-cli built it`);
        continue;
      }
      if (outcome.value !== vector.encoding.cardanoBinary.scriptHash) {
        disagreements.push(
          `${vector.id}: ours ${vector.encoding.cardanoBinary.scriptHash}, cardano-cli ${outcome.value}`,
        );
      }
    }

    expect(disagreements.join('\n')).toBe('');
    // Every vector was either agreed on or refused for the one known reason.
    expect(refused.length + (vectors.length - refused.length)).toBe(vectors.length);
  });
});

describeCli('cardano-cli validates more than the ledger', () => {
  it('refuses a threshold larger than its sub-script count', () => {
    // The ledger accepts this: isValidMOf runs out of sub-scripts with n still
    // above zero and returns false. cardano-cli will not construct it at all.
    const script = parseScript({
      type: 'atLeast',
      required: 3,
      scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }],
    });
    const outcome = cli.scriptHash(script);
    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') {
      expect(outcome.error).toMatch(/Required number of script signatures/i);
    }
  });

  it('accepts a negative threshold, so the validation is one-sided', () => {
    const script = parseScript({
      type: 'atLeast',
      required: -1,
      scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }],
    });
    expect(cli.scriptHash(script).status).toBe('ok');
  });

  it('accepts every empty container', () => {
    for (const json of [
      { type: 'all', scripts: [] },
      { type: 'any', scripts: [] },
      { type: 'atLeast', required: 0, scripts: [] },
    ]) {
      expect(cli.scriptHash(parseScript(json)).status, JSON.stringify(json)).toBe('ok');
    }
  });
});

describeCli('cardano-cli agrees on credentials', () => {
  /**
   * Address derivation is a pure function of the script hash, so running it
   * over every vector would re-test one code path 114 times. A spread across
   * families is enough, and keeps the process spawn count down.
   */
  function sample(vectors: Vector[]): Vector[] {
    const byFamily = new Map<string, Vector>();
    for (const v of vectors) {
      if (!byFamily.has(v.family) && !cliRefuses(parseScript(v.script))) byFamily.set(v.family, v);
    }
    return [...byFamily.values()];
  }

  it('reproduces the enterprise address on both networks', async () => {
    const problems: string[] = [];
    for (const vector of sample(await loadAllVectors())) {
      const script = parseScript(vector.script);
      const hash = vector.encoding.cardanoBinary.scriptHash;
      for (const [network, ours] of [
        ['mainnet', enterpriseAddress(hash, 'mainnet')],
        ['testnet', enterpriseAddress(hash, 'preview')],
      ] as const) {
        const outcome = cli.enterpriseAddress(script, network);
        if (outcome.status !== 'ok') problems.push(`${vector.id} ${network}: ${outcome.error}`);
        else if (outcome.value !== ours) {
          problems.push(`${vector.id} ${network}: ours ${ours}, cardano-cli ${outcome.value}`);
        }
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('reproduces the base address with a script in both credential slots', async () => {
    const problems: string[] = [];
    for (const vector of sample(await loadAllVectors())) {
      const script = parseScript(vector.script);
      const hash = vector.encoding.cardanoBinary.scriptHash;
      const outcome = cli.baseAddress(script, 'testnet');
      const ours = baseAddressScriptStake(hash, hash, 'preview');
      if (outcome.status !== 'ok') problems.push(`${vector.id}: ${outcome.error}`);
      else if (outcome.value !== ours) {
        problems.push(`${vector.id}: ours ${ours}, cardano-cli ${outcome.value}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('reproduces the reward address', async () => {
    const problems: string[] = [];
    for (const vector of sample(await loadAllVectors())) {
      const script = parseScript(vector.script);
      const hash = vector.encoding.cardanoBinary.scriptHash;
      const outcome = cli.rewardAddress(script, 'testnet');
      const ours = rewardAddress(hash, 'preview');
      if (outcome.status !== 'ok') problems.push(`${vector.id}: ${outcome.error}`);
      else if (outcome.value !== ours) {
        problems.push(`${vector.id}: ours ${ours}, cardano-cli ${outcome.value}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });
});
