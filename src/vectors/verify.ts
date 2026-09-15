import { parseScript } from '../model/json.js';
import { encodeScript, hashPreimage, scriptHash } from '../encode/script.js';
import { toHex } from '../encode/cbor.js';
import { evaluate } from '../evaluate/evaluate.js';
import type { Vector } from './schema.js';

export interface VerificationFinding {
  vectorId: string;
  kind: 'encoding' | 'hash' | 'satisfaction' | 'contradiction';
  detail: string;
  expected: string;
  actual: string;
}

/**
 * Re-derive everything in a vector from its script and report disagreements.
 *
 * This is the routine a port runs to claim conformance, and the routine CI runs
 * to prove the committed corpus still matches the generator. The two are the
 * same check because the corpus is the specification's executable half.
 *
 * `contradiction` findings are different in kind from the rest. They mean a
 * real node disagreed with the reference evaluator, so the defect is in the
 * evaluator or the spec rather than in whatever is being verified.
 */
export function verifyVector(vector: Vector): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const script = parseScript(vector.script);

  const cborHex = toHex(encodeScript(script));
  if (cborHex !== vector.encoding.cborHex) {
    findings.push({
      vectorId: vector.id,
      kind: 'encoding',
      detail: 'CBOR does not match the recorded encoding',
      expected: vector.encoding.cborHex,
      actual: cborHex,
    });
  }

  const preimageHex = toHex(hashPreimage(script));
  if (preimageHex !== vector.encoding.preimageHex) {
    findings.push({
      vectorId: vector.id,
      kind: 'encoding',
      detail: 'hash preimage does not match, so the language tag or the CBOR differs',
      expected: vector.encoding.preimageHex,
      actual: preimageHex,
    });
  }

  const hash = scriptHash(script);
  if (hash !== vector.encoding.scriptHash) {
    findings.push({
      vectorId: vector.id,
      kind: 'hash',
      detail: 'script hash does not match',
      expected: vector.encoding.scriptHash,
      actual: hash,
    });
  }

  for (const testCase of vector.satisfaction) {
    const result = evaluate(script, {
      signers: testCase.signers,
      ...(testCase.validityStart === undefined ? {} : { validityStart: testCase.validityStart }),
      ...(testCase.validityEnd === undefined ? {} : { validityEnd: testCase.validityEnd }),
    });
    if (result.satisfied !== testCase.expected) {
      findings.push({
        vectorId: vector.id,
        kind: 'satisfaction',
        detail: `case ${testCase.id}: ${result.trace.reason}`,
        expected: String(testCase.expected),
        actual: String(result.satisfied),
      });
    }
  }

  findings.push(...contradictions(vector));
  return findings;
}

/**
 * Chain observations that disagree with the reference expectation for the same
 * case. Surfaced loudly and never resolved by editing the observation: the node
 * is the authority, and a contradiction is a finding against the spec.
 */
export function contradictions(vector: Vector): VerificationFinding[] {
  const byCase = new Map(vector.satisfaction.map((c) => [c.id, c]));
  const findings: VerificationFinding[] = [];

  for (const observation of vector.onchain ?? []) {
    if (!observation.caseId) continue;
    const testCase = byCase.get(observation.caseId);
    if (!testCase) continue;
    if (observation.accepted !== testCase.expected) {
      findings.push({
        vectorId: vector.id,
        kind: 'contradiction',
        detail: `case ${testCase.id} on ${observation.network}: a node disagreed with the reference evaluator. The node is right. ${observation.error ?? ''}`.trim(),
        expected: `reference says ${testCase.expected}`,
        actual: `node says ${observation.accepted}${observation.txHash ? ` (${observation.txHash})` : ''}`,
      });
    }
  }
  return findings;
}

export function verifyCorpus(vectors: Vector[]): VerificationFinding[] {
  return vectors.flatMap(verifyVector);
}
