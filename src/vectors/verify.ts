import { parseScript } from '../model/json.js';
import {
  encodeScript,
  hashPreimage,
  scriptHash,
  isEncodingSensitive,
} from '../encode/script.js';
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

  // Both encodings are checked. A port may implement only one, but the corpus
  // records both because the same script has two valid hashes.
  for (const encoding of ['definite', 'cardanoBinary'] as const) {
    const recorded = vector.encoding[encoding];

    const cborHex = toHex(encodeScript(script, encoding));
    if (cborHex !== recorded.cborHex) {
      findings.push({
        vectorId: vector.id,
        kind: 'encoding',
        detail: `${encoding}: CBOR does not match the recorded encoding`,
        expected: recorded.cborHex,
        actual: cborHex,
      });
    }

    const preimageHex = toHex(hashPreimage(script, encoding));
    if (preimageHex !== recorded.preimageHex) {
      findings.push({
        vectorId: vector.id,
        kind: 'encoding',
        detail: `${encoding}: hash preimage does not match, so the language tag or the CBOR differs`,
        expected: recorded.preimageHex,
        actual: preimageHex,
      });
    }

    const hash = scriptHash(script, encoding);
    if (hash !== recorded.scriptHash) {
      findings.push({
        vectorId: vector.id,
        kind: 'hash',
        detail: `${encoding}: script hash does not match`,
        expected: recorded.scriptHash,
        actual: hash,
      });
    }
  }

  const sensitive = isEncodingSensitive(script);
  if (sensitive !== vector.encoding.encodingSensitive) {
    findings.push({
      vectorId: vector.id,
      kind: 'encoding',
      detail: 'encodingSensitive does not match the script structure',
      expected: String(vector.encoding.encodingSensitive),
      actual: String(sensitive),
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
