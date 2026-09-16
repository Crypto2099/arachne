import { isContainer, type NativeScript, type ScriptContainer } from './types.js';

/**
 * Structural facts about a script, computed in one pass.
 *
 * `depth` counts nesting levels with a bare leaf at depth 1, so `all[sig]` is 2.
 * `keyHashes` is the DISTINCT set; `sigCount` is the total number of `sig` nodes.
 * The two differ whenever a key hash appears more than once, and that difference
 * is exactly where a threshold implementation that de-duplicates keys diverges
 * from the ledger, which counts satisfied sub-scripts rather than distinct keys.
 * See spec/03-satisfaction.md.
 */
export interface ScriptShape {
  depth: number;
  nodeCount: number;
  sigCount: number;
  keyHashes: string[];
  timelockCount: number;
  maxBreadth: number;
  containerCounts: Record<'all' | 'any' | 'atLeast', number>;
}

export function shapeOf(script: NativeScript): ScriptShape {
  const keyHashes = new Set<string>();
  const containerCounts = { all: 0, any: 0, atLeast: 0 };
  let nodeCount = 0;
  let sigCount = 0;
  let timelockCount = 0;
  let maxBreadth = 0;

  // `depth` is the one value that has to come back up from the leaves, so
  // this is a post-order walk: a container's depth is one more than its
  // deepest child, and that is not known until every child has been visited.
  // The work stack below holds one frame per container still open, tracking
  // which child comes next and the deepest one seen so far, in place of the
  // native stack frame recursion would have used per nesting level.
  interface Frame {
    node: ScriptContainer;
    index: number;
    deepest: number;
  }
  const stack: Frame[] = [];
  let node: NativeScript | undefined = script;
  let result = 0;

  while (node !== undefined || stack.length > 0) {
    if (node !== undefined) {
      nodeCount += 1;
      const current: NativeScript = node;
      node = undefined;
      switch (current.type) {
        case 'sig':
          sigCount += 1;
          keyHashes.add(current.keyHash.toLowerCase());
          result = 1;
          break;
        case 'after':
        case 'before':
          timelockCount += 1;
          result = 1;
          break;
        default: {
          containerCounts[current.type] += 1;
          maxBreadth = Math.max(maxBreadth, current.scripts.length);
          if (current.scripts.length === 0) {
            // An empty container still occupies a level of its own.
            result = 1;
          } else {
            stack.push({ node: current, index: 0, deepest: 0 });
            node = current.scripts[0];
          }
        }
      }
      continue;
    }

    // Ascend: `result` is the depth of the child just finished.
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    frame.deepest = Math.max(frame.deepest, result);
    frame.index += 1;
    if (frame.index < frame.node.scripts.length) {
      node = frame.node.scripts[frame.index];
    } else {
      stack.pop();
      result = frame.deepest + 1;
    }
  }

  return {
    depth: result,
    nodeCount,
    sigCount,
    keyHashes: [...keyHashes].sort(),
    timelockCount,
    maxBreadth,
    containerCounts,
  };
}

/**
 * Structural problems that make a script unsatisfiable or meaningless while
 * leaving it perfectly well-formed. The ledger accepts every one of these; they
 * are not validation errors, they are the degenerate cases a conformance corpus
 * exists to pin down. Reported, never thrown.
 */
export interface ScriptRemark {
  path: string;
  code:
    | 'empty-all'
    | 'empty-any'
    | 'required-zero'
    | 'required-exceeds-children'
    | 'duplicate-key-in-threshold'
    | 'contradictory-timelock';
  detail: string;
}

export function remarksFor(script: NativeScript): ScriptRemark[] {
  const remarks: ScriptRemark[] = [];

  // Pre-order: a remark's own detection never depends on a child's, so unlike
  // `shapeOf` this needs no result to carry back up and an explicit stack of
  // nodes still to visit is enough. Children are pushed in reverse so that
  // popping them visits left to right, reproducing the order `forEach` gave
  // the recursive version.
  const stack: Array<{ node: NativeScript; path: string }> = [{ node: script, path: '' }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, path } = frame;
    if (!isContainer(node)) continue;

    if (node.type === 'all' && node.scripts.length === 0) {
      remarks.push({
        path,
        code: 'empty-all',
        detail: 'An empty "all" is vacuously satisfied by any witness set, including none.',
      });
    }
    if (node.type === 'any' && node.scripts.length === 0) {
      remarks.push({
        path,
        code: 'empty-any',
        detail: 'An empty "any" can never be satisfied.',
      });
    }
    if (node.type === 'atLeast') {
      if (node.required <= 0) {
        remarks.push({
          path,
          code: 'required-zero',
          detail: `required is ${node.required}, so the threshold is met with no witnesses at all.`,
        });
      }
      if (node.required > node.scripts.length) {
        remarks.push({
          path,
          code: 'required-exceeds-children',
          detail: `required is ${node.required} but only ${node.scripts.length} sub-scripts exist, so it can never be satisfied.`,
        });
      }
      const seen = new Set<string>();
      for (const child of node.scripts) {
        if (child.type !== 'sig') continue;
        const key = child.keyHash.toLowerCase();
        if (seen.has(key)) {
          remarks.push({
            path,
            code: 'duplicate-key-in-threshold',
            detail: `Key ${key.slice(0, 8)} appears more than once directly under a threshold, so one signature counts more than once toward required.`,
          });
        }
        seen.add(key);
      }
    }

    for (let i = node.scripts.length - 1; i >= 0; i -= 1) {
      stack.push({ node: node.scripts[i] as NativeScript, path: `${path}/${node.type}[${i}]` });
    }
  }

  return remarks;
}
