import type { NativeScript, NativeScriptType } from '../model/types.js';
import { witnessFrom, type WitnessContext } from './witness.js';

export interface EvalNode {
  path: string;
  type: NativeScriptType;
  satisfied: boolean;
  /** Why this node reached its verdict, in terms a reader can act on. */
  reason: string;
  children: EvalNode[];
}

export interface EvalResult {
  satisfied: boolean;
  trace: EvalNode;
  /**
   * Key hashes that would change the verdict if they signed. Empty when the
   * script is already satisfied, and empty when no set of signatures can ever
   * satisfy it, which are very different situations. Check `satisfied` first.
   */
  missingSigners: string[];
}

/**
 * The reference satisfaction oracle.
 *
 * This mirrors the ledger's evaluation of a timelock script, and the whole
 * corpus exists to hold it to that. Where this disagrees with a node, the node
 * is right and this is a defect. See spec/05-conformance.md for how a
 * disagreement is recorded and resolved.
 *
 * Three rules here are the ones implementations get wrong:
 *
 *  1. A threshold counts SATISFIED SUB-SCRIPTS, not distinct signing keys. The
 *     same key hash appearing twice under one `atLeast` contributes twice when
 *     that key signs. Flattening a script into a key set loses this.
 *  2. Nesting does not flatten. `all[any[A,B], sig C]` needs C and one of A or
 *     B. Accumulating key hashes up the tree and comparing counts at the root
 *     turns that into a demand for all three.
 *  3. A timelock against an absent interval bound FAILS. It does not pass, and
 *     it is not neutral.
 */
export function evaluate(script: NativeScript, context: WitnessContext): EvalResult {
  const witness = witnessFrom(context);
  const missing = new Set<string>();

  const walk = (node: NativeScript, path: string): EvalNode => {
    switch (node.type) {
      case 'sig': {
        const satisfied = witness.signers.has(node.keyHash.toLowerCase());
        if (!satisfied) missing.add(node.keyHash.toLowerCase());
        return {
          path,
          type: 'sig',
          satisfied,
          reason: satisfied
            ? `signed by ${node.keyHash.slice(0, 8)}`
            : `no witness for ${node.keyHash.slice(0, 8)}`,
          children: [],
        };
      }

      case 'after': {
        // Satisfied only if the transaction declares a lower bound at or after
        // the locked slot. An absent bound fails.
        if (witness.validityStart === undefined) {
          return {
            path,
            type: 'after',
            satisfied: false,
            reason: `requires slot >= ${node.slot} but the transaction sets no validity start`,
            children: [],
          };
        }
        const satisfied = node.slot <= witness.validityStart;
        return {
          path,
          type: 'after',
          satisfied,
          reason: satisfied
            ? `validity start ${witness.validityStart} is at or after ${node.slot}`
            : `validity start ${witness.validityStart} is before ${node.slot}`,
          children: [],
        };
      }

      case 'before': {
        // Satisfied only if the transaction declares an upper bound at or
        // before the locked slot. An absent bound fails.
        if (witness.validityEnd === undefined) {
          return {
            path,
            type: 'before',
            satisfied: false,
            reason: `requires ttl <= ${node.slot} but the transaction sets no validity end`,
            children: [],
          };
        }
        const satisfied = witness.validityEnd <= node.slot;
        return {
          path,
          type: 'before',
          satisfied,
          reason: satisfied
            ? `ttl ${witness.validityEnd} is at or before ${node.slot}`
            : `ttl ${witness.validityEnd} is after ${node.slot}`,
          children: [],
        };
      }

      case 'all': {
        const children = node.scripts.map((child, i) => walk(child, `${path}/all[${i}]`));
        const failed = children.filter((c) => !c.satisfied).length;
        return {
          path,
          type: 'all',
          // Vacuously true when empty, which is the standard reading of "all"
          // over an empty collection and what the ledger does.
          satisfied: failed === 0,
          reason:
            children.length === 0
              ? 'empty "all" is vacuously satisfied'
              : failed === 0
                ? `all ${children.length} sub-scripts satisfied`
                : `${failed} of ${children.length} sub-scripts unsatisfied`,
          children,
        };
      }

      case 'any': {
        const children = node.scripts.map((child, i) => walk(child, `${path}/any[${i}]`));
        const met = children.filter((c) => c.satisfied).length;
        return {
          path,
          type: 'any',
          satisfied: met > 0,
          reason:
            children.length === 0
              ? 'empty "any" can never be satisfied'
              : met > 0
                ? `${met} of ${children.length} sub-scripts satisfied`
                : `none of ${children.length} sub-scripts satisfied`,
          children,
        };
      }

      case 'atLeast': {
        const children = node.scripts.map((child, i) => walk(child, `${path}/atLeast[${i}]`));
        // Count satisfied sub-scripts, not distinct keys. A duplicated sig that
        // has signed contributes once per occurrence.
        const met = children.filter((c) => c.satisfied).length;
        return {
          path,
          type: 'atLeast',
          satisfied: met >= node.required,
          reason:
            node.required <= 0
              ? `required is ${node.required}, satisfied with no witnesses`
              : node.required > children.length
                ? `required is ${node.required} but only ${children.length} sub-scripts exist, unsatisfiable`
                : `${met} of ${children.length} sub-scripts satisfied, ${node.required} required`,
          children,
        };
      }
    }
  };

  const trace = walk(script, '');
  return {
    satisfied: trace.satisfied,
    trace,
    missingSigners: trace.satisfied ? [] : [...missing].sort(),
  };
}

/** Flatten a trace to the unsatisfied leaves, which is what a caller reports to a user. */
export function failingLeaves(trace: EvalNode): EvalNode[] {
  if (trace.satisfied) return [];
  if (trace.children.length === 0) return [trace];
  return trace.children.flatMap(failingLeaves);
}

/** Render a trace as an indented tree for a test failure message or a CLI. */
export function formatTrace(node: EvalNode, indent = 0): string {
  const mark = node.satisfied ? 'PASS' : 'FAIL';
  const pad = '  '.repeat(indent);
  const head = `${pad}${mark} ${node.type}: ${node.reason}`;
  return [head, ...node.children.map((c) => formatTrace(c, indent + 1))].join('\n');
}
