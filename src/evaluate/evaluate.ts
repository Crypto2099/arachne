import {
  isContainer,
  type NativeScript,
  type NativeScriptType,
  type ScriptContainer,
} from '../model/types.js';
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

/** A node with no `scripts` of its own: what `evalLeaf` below handles directly. */
type LeafScript = Exclude<NativeScript, ScriptContainer>;

/** One open container, gathering its children's verdicts before its own can be computed. */
interface EvalFrame {
  node: ScriptContainer;
  path: string;
  index: number;
  children: EvalNode[];
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

  function evalLeaf(node: LeafScript, path: string): EvalNode {
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
    }
  }

  function finishContainer(frame: EvalFrame): EvalNode {
    const { node, path, children } = frame;
    switch (node.type) {
      case 'all': {
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
  }

  // Post-order: a container's verdict needs every child's verdict first, so
  // this keeps a work stack of open containers (one frame per nesting level,
  // tracking the next child index and the verdicts gathered so far) instead
  // of a native stack frame per level. `pending` is the node queued to
  // descend into next; when it is empty the loop is ascending with
  // `completed` holding the child verdict just finished.
  const stack: EvalFrame[] = [];
  let pending: { node: NativeScript; path: string } | undefined = { node: script, path: '' };
  let completed: EvalNode | undefined;

  while (pending !== undefined || stack.length > 0) {
    if (pending !== undefined) {
      const { node, path }: { node: NativeScript; path: string } = pending;
      pending = undefined;
      if (!isContainer(node)) {
        completed = evalLeaf(node, path);
      } else if (node.scripts.length === 0) {
        completed = finishContainer({ node, path, index: 0, children: [] });
      } else {
        stack.push({ node, path, index: 0, children: [] });
        pending = { node: node.scripts[0] as NativeScript, path: `${path}/${node.type}[0]` };
      }
      continue;
    }

    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    frame.children.push(completed as EvalNode);
    completed = undefined;
    frame.index += 1;
    if (frame.index < frame.node.scripts.length) {
      pending = {
        node: frame.node.scripts[frame.index] as NativeScript,
        path: `${frame.path}/${frame.node.type}[${frame.index}]`,
      };
    } else {
      stack.pop();
      completed = finishContainer(frame);
    }
  }

  const trace = completed as EvalNode;
  return {
    satisfied: trace.satisfied,
    trace,
    missingSigners: trace.satisfied ? [] : [...missing].sort(),
  };
}

/** Flatten a trace to the unsatisfied leaves, which is what a caller reports to a user. */
export function failingLeaves(trace: EvalNode): EvalNode[] {
  // Iterative pre-order: children are pushed in reverse so popping visits
  // them left to right, matching the order `flatMap` produced.
  const out: EvalNode[] = [];
  const stack: EvalNode[] = [trace];
  while (stack.length > 0) {
    const node = stack.pop() as EvalNode;
    if (node.satisfied) continue;
    if (node.children.length === 0) {
      out.push(node);
      continue;
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i] as EvalNode);
    }
  }
  return out;
}

/** Render a trace as an indented tree for a test failure message or a CLI. */
export function formatTrace(node: EvalNode, indent = 0): string {
  // Iterative pre-order text emission: each stack entry carries the indent it
  // should print at, pushed in reverse so popping reproduces the same
  // top-to-bottom order the recursive version joined lines in.
  const lines: string[] = [];
  const stack: Array<{ node: EvalNode; indent: number }> = [{ node, indent }];
  while (stack.length > 0) {
    const frame = stack.pop() as { node: EvalNode; indent: number };
    const mark = frame.node.satisfied ? 'PASS' : 'FAIL';
    const pad = '  '.repeat(frame.indent);
    lines.push(`${pad}${mark} ${frame.node.type}: ${frame.node.reason}`);
    for (let i = frame.node.children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: frame.node.children[i] as EvalNode, indent: frame.indent + 1 });
    }
  }
  return lines.join('\n');
}
