import { isContainer, type NativeScript } from './types.js';

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

  const walk = (node: NativeScript): number => {
    nodeCount += 1;
    switch (node.type) {
      case 'sig':
        sigCount += 1;
        keyHashes.add(node.keyHash.toLowerCase());
        return 1;
      case 'after':
      case 'before':
        timelockCount += 1;
        return 1;
      default: {
        containerCounts[node.type] += 1;
        maxBreadth = Math.max(maxBreadth, node.scripts.length);
        let deepest = 0;
        for (const child of node.scripts) deepest = Math.max(deepest, walk(child));
        // An empty container still occupies a level of its own.
        return deepest + 1;
      }
    }
  };

  const depth = walk(script);
  return {
    depth,
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

  const walk = (node: NativeScript, path: string): void => {
    if (!isContainer(node)) return;

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

    node.scripts.forEach((child, i) => walk(child, `${path}/${node.type}[${i}]`));
  };

  walk(script, '');
  return remarks;
}
