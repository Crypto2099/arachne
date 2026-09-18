import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHAIN_EVIDENCE_PATH, loadChainEvidence } from '../../../src/chain/evidence.js';
import {
  DEFAULT_OBSERVED_SCRIPTS_PATH,
  deriveObservedScripts,
  serializeObservedScripts,
  type ObservedScriptRecord,
  type ObservedScriptsFile,
} from '../../../src/chain/observed.js';
import { decodeScript, scriptHashFromCbor } from '../../../src/encode/decode.js';
import { encodeScript } from '../../../src/encode/script.js';
import { serializeScript } from '../../../src/model/json.js';
import { toHex } from '../../../src/encode/cbor.js';
import { loadAllVectors } from '../../../src/vectors/load.js';
import type { Vector } from '../../../src/vectors/schema.js';

/**
 * The decoder, against bytes this project did not produce.
 *
 * `test/conformance/roundtrip.test.ts` already decodes every vector in both
 * framings, and `test/unit/slot-range.test.ts` decodes strings written by hand
 * to state a rule. Both are worth having and neither is independent evidence:
 * an encoder and a decoder written together agree about framing whether or not
 * the framing is right, so a corpus round-trip proves self-consistency and
 * stops there. Every byte string below was framed by other software, submitted
 * to preprod, and accepted by a node. Provenance for each is in
 * `chain-evidence/observations.json`, and the transaction bytes there prove
 * their own hashes offline.
 */
let record: ObservedScriptsFile;
let vectors: Vector[];
let committed: string;

const find = (prefix: string): ObservedScriptRecord => {
  const match = record.scripts.filter((s) => s.scriptHash.startsWith(prefix));
  expect(match, `expected exactly one observed script starting ${prefix}`).toHaveLength(1);
  return match[0]!;
};

beforeAll(async () => {
  const evidence = await loadChainEvidence(DEFAULT_CHAIN_EVIDENCE_PATH);
  vectors = await loadAllVectors();
  record = deriveObservedScripts(evidence, vectors);
  committed = await readFile(DEFAULT_OBSERVED_SCRIPTS_PATH, 'utf8');
});

describe('the committed observed script set', () => {
  it('is exactly what the observations produce', () => {
    // The same guarantee a vector has: hand-editing this file fails the build,
    // so it stays derived from the transaction bytes rather than becoming a
    // second place a claim about the chain can be written down.
    expect(serializeObservedScripts(record)).toBe(committed);
  });

  it('records the hash of the bytes as received, for every script', () => {
    for (const script of record.scripts) {
      expect(scriptHashFromCbor(script.cborHex), script.scriptHash).toBe(script.scriptHash);
      expect(script.cborHex.length / 2, script.scriptHash).toBe(script.scriptBytes);
    }
  });

  it('names a real transaction for every script it carries', () => {
    for (const script of record.scripts) {
      expect(script.carriedBy.length, script.scriptHash).toBeGreaterThan(0);
      for (const carrier of script.carriedBy) {
        expect(carrier.txHash, script.scriptHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('scripts a node accepted, decoded', () => {
  it('re-encodes to the exact bytes it read, in every framing it reports', () => {
    const problems: string[] = [];
    for (const script of record.scripts) {
      if (!script.decodable) continue;
      const decoded = decodeScript(script.cborHex);
      for (const framing of script.framings ?? []) {
        const reencoded = toHex(encodeScript(decoded.script, framing));
        if (reencoded !== script.cborHex) {
          problems.push(`${script.scriptHash} ${framing}: bytes changed on re-encode`);
        }
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('changes the hash when re-encoded in a framing it does not report', () => {
    // The reason `scriptHashFromCbor` exists. Where only one framing
    // reproduces the bytes, the other one is a different script hash and so a
    // different address: decoding and re-encoding would silently move funds to
    // an address nobody funded. Proven here on bytes a node accepted rather
    // than on a constructed example.
    const oneSided = record.scripts.filter((s) => s.decodable && s.framings?.length === 1);
    expect(oneSided.length).toBeGreaterThan(0);

    for (const script of oneSided) {
      const decoded = decodeScript(script.cborHex);
      const other = script.framings![0] === 'definite' ? 'cardanoBinary' : 'definite';
      const reencoded = toHex(encodeScript(decoded.script, other));
      expect(reencoded, script.scriptHash).not.toBe(script.cborHex);
      expect(scriptHashFromCbor(reencoded), script.scriptHash).not.toBe(script.scriptHash);
    }
  });
});

describe('a script the chain accepted and this library cannot decode', () => {
  // `all [ sig(k), before(18446744073709551615) ]`, accepted on preprod.
  // 2^64-1 is the largest legal slot the CDDL admits and is far above
  // Number.MAX_SAFE_INTEGER, so this AST cannot hold it exactly. Refusing to
  // decode is correct: the alternative is truncating it to 2^64, re-encoding
  // to different bytes and returning the wrong script hash. See
  // `test/unit/slot-range.test.ts` for the rule stated in isolation. What
  // this adds is that the case is not hypothetical.
  const HASH = 'd66ed8e0a53cd02e';

  it('is in the record, undecodable, with the decoder error kept', () => {
    const script = find(HASH);
    expect(script.decodable).toBe(false);
    expect(script.decodeError).toMatch(/MAX_SAFE_INTEGER/);
    expect(script.framings).toBeUndefined();
    expect(script.shape).toBeUndefined();
  });

  it('still hashes, because hashing never decodes', () => {
    const script = find(HASH);
    expect(() => decodeScript(script.cborHex)).toThrow(/MAX_SAFE_INTEGER/);
    expect(scriptHashFromCbor(script.cborHex)).toBe(script.scriptHash);
  });
});

describe('one script, two framings, both accepted on chain', () => {
  // The same 24-key `any`, funded and spent twice: once at the address its
  // definite-length encoding produces, once at the address cardano-cli's
  // framing produces. This is spec/07-encoding-divergence.md as a pair of
  // transactions rather than as an argument.
  const DEFINITE = 'b7e9fae91f0bd211';
  const CARDANO_BINARY = 'cca7321c5acd49f6';

  it('decodes both to the same script', () => {
    const a = decodeScript(find(DEFINITE).cborHex);
    const b = decodeScript(find(CARDANO_BINARY).cborHex);
    expect(serializeScript(a.script)).toEqual(serializeScript(b.script));
  });

  it('keeps them apart by bytes, framing and hash', () => {
    const a = find(DEFINITE);
    const b = find(CARDANO_BINARY);
    expect(a.cborHex).not.toBe(b.cborHex);
    expect(a.scriptBytes).toBe(b.scriptBytes);
    expect(a.framings).toEqual(['definite']);
    expect(b.framings).toEqual(['cardanoBinary']);
    expect(a.scriptHash).not.toBe(b.scriptHash);
  });
});

describe('observed scripts the corpus also generates', () => {
  it('are byte-identical to the vector they name', () => {
    const linked = record.scripts.filter((s) => s.vectorId);
    // The five the chain exercises used corpus scripts for; a drop here means
    // an exercise stopped covering one.
    expect(linked.length).toBeGreaterThanOrEqual(5);

    for (const script of linked) {
      const vector = vectors.find((v) => v.id === script.vectorId);
      expect(vector, script.vectorId).toBeDefined();
      const encodings = [vector!.encoding.definite, vector!.encoding.cardanoBinary];
      const match = encodings.find((e) => e.cborHex === script.cborHex);
      expect(match, `${script.vectorId}: no encoding matches the observed bytes`).toBeDefined();
      expect(match!.scriptHash, script.vectorId).toBe(script.scriptHash);
    }
  });

  it('covers the degenerate shapes the chain exercises submitted', () => {
    // These are the cases with no analogue anywhere else: containers that are
    // empty or out of range, which a node accepted and which therefore cannot
    // be dismissed as unreachable. Losing one means an exercise regressed.
    const ids = new Set(record.scripts.map((s) => s.vectorId));
    for (const id of [
      'degenerate/empty-all',
      'degenerate/empty-any',
      'degenerate/empty-atleast-0',
      'degenerate/atleast-negative',
      'threshold-matrix/atleast-0-of-3',
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});
