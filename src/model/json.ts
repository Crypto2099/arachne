import type { NativeScript } from './types.js';

export class ScriptParseError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${path || '<root>'}: ${message}`);
    this.name = 'ScriptParseError';
    this.path = path;
  }
}

const HEX28 = /^[0-9a-f]{56}$/;

/**
 * Parse the cardano-cli / MeshJS JSON shape into the AST, rejecting anything
 * that would not round-trip.
 *
 * Deliberately strict where the ledger is strict: a key hash is 28 bytes, a slot
 * is a non-negative integer, `required` is an integer. Deliberately permissive
 * where the ledger is permissive: an empty `scripts` array, a `required` of zero
 * and a `required` larger than the child count all parse, because all three are
 * well-formed scripts with real hashes that a node will accept. Use
 * `remarksFor` to surface them.
 *
 * Callers frequently hand this a wrapper such as
 * `{ type: 'timelock', value: {...} }`, which is how a script arrives from
 * Blockfrost and how the Ekklesia fixtures store it. `unwrapScript` handles that
 * before parsing.
 */
export function parseScript(input: unknown, path = ''): NativeScript {
  // Iterative rather than recursive: a linear "all" nest of depth 5450 fits
  // inside a 16,384-byte transaction, and this has to parse one that deep
  // without spending a native stack frame per level. A container cannot be
  // built until every child is, so this keeps a work stack of open containers
  // instead: `parseHead` validates one JSON node's own fields without
  // descending into its children, and the loop drives the descent into the
  // next not-yet-parsed child and the ascent back to the parent once the last
  // one is done, which is what the call stack did implicitly before.
  interface Frame {
    type: 'all' | 'any' | 'atLeast';
    required: number; // unused except when type is 'atLeast'
    path: string;
    items: unknown[];
    index: number;
    children: NativeScript[];
  }

  const stack: Frame[] = [];
  let pending: { value: unknown; path: string } | undefined = { value: input, path };
  let completed: NativeScript | undefined;

  const finish = (frame: Frame): NativeScript =>
    frame.type === 'atLeast'
      ? { type: 'atLeast', required: frame.required, scripts: frame.children }
      : { type: frame.type, scripts: frame.children };

  while (pending !== undefined || stack.length > 0) {
    if (pending !== undefined) {
      const { value, path: at }: { value: unknown; path: string } = pending;
      pending = undefined;
      const head = parseHead(value, at);
      if (head.container) {
        const frame: Frame = {
          type: head.type,
          required: head.type === 'atLeast' ? head.required : 0,
          path: at,
          items: head.items,
          index: 0,
          children: [],
        };
        if (frame.items.length === 0) {
          completed = finish(frame);
        } else {
          stack.push(frame);
          pending = { value: frame.items[0], path: `${at}/${frame.type}[0]` };
        }
      } else {
        completed = head.script;
      }
      continue;
    }

    // Ascend: `completed` holds the finished child. Attach it, then either
    // descend into the next sibling or, once the container is exhausted,
    // finish it so the next loop turn ascends one level further.
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    frame.children.push(completed as NativeScript);
    completed = undefined;
    frame.index += 1;
    if (frame.index < frame.items.length) {
      pending = {
        value: frame.items[frame.index],
        path: `${frame.path}/${frame.type}[${frame.index}]`,
      };
    } else {
      stack.pop();
      completed = finish(frame);
    }
  }

  return completed as NativeScript;
}

type ParsedHead =
  | { container: false; script: NativeScript }
  | { container: true; type: 'all' | 'any'; items: unknown[] }
  | { container: true; type: 'atLeast'; required: number; items: unknown[] };

/** Validate one JSON node's own fields without descending into its children. */
function parseHead(input: unknown, path: string): ParsedHead {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScriptParseError('expected a JSON object', path);
  }
  const node = input as Record<string, unknown>;
  const type = node['type'];
  if (typeof type !== 'string') {
    throw new ScriptParseError('missing string "type"', path);
  }

  switch (type) {
    case 'sig': {
      const keyHash = node['keyHash'];
      if (typeof keyHash !== 'string' || !HEX28.test(keyHash.toLowerCase())) {
        throw new ScriptParseError('"keyHash" must be 56 lowercase hex characters', path);
      }
      return { container: false, script: { type: 'sig', keyHash: keyHash.toLowerCase() } };
    }
    case 'all':
    case 'any':
      return { container: true, type, items: parseChildrenArray(node['scripts'], path) };
    case 'atLeast': {
      const required = node['required'];
      if (typeof required !== 'number' || !Number.isInteger(required)) {
        throw new ScriptParseError('"required" must be an integer', path);
      }
      return {
        container: true,
        type: 'atLeast',
        required,
        items: parseChildrenArray(node['scripts'], path),
      };
    }
    case 'after':
    case 'before': {
      const slot = node['slot'];
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
        throw new ScriptParseError('"slot" must be a non-negative integer', path);
      }
      return { container: false, script: { type, slot } };
    }
    default:
      throw new ScriptParseError(`unknown script type "${type}"`, path);
  }
}

function parseChildrenArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScriptParseError('"scripts" must be an array', path);
  }
  return value;
}

/**
 * Accept either a bare script or a `{ type, value }` envelope and return the
 * bare script. Blockfrost labels a native script `timelock`; some tools use
 * `simple` or `native`. The envelope tag is metadata about the script language,
 * not a script type, and it is not part of what gets hashed.
 */
export function unwrapScript(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const node = input as Record<string, unknown>;
  const tag = node['type'];
  if (typeof tag === 'string' && 'value' in node) {
    if (tag === 'timelock' || tag === 'simple' || tag === 'native') return node['value'];
  }
  return input;
}

/**
 * Serialize to JSON with keys in a fixed order, so two implementations that
 * agree on a script produce byte-identical files. This governs the JSON in a
 * vector file. It has no bearing on the CBOR, which has its own canonical form
 * and is what the hash is taken over.
 */
export function serializeScript(script: NativeScript): unknown {
  switch (script.type) {
    case 'sig':
      return { type: 'sig', keyHash: script.keyHash };
    case 'all':
    case 'any':
      return { type: script.type, scripts: script.scripts.map(serializeScript) };
    case 'atLeast':
      return {
        type: 'atLeast',
        required: script.required,
        scripts: script.scripts.map(serializeScript),
      };
    case 'after':
    case 'before':
      return { type: script.type, slot: script.slot };
  }
}

/**
 * The same JSON text `JSON.stringify(serializeScript(script))` would produce,
 * for scripts too deep for that expression to run at all.
 *
 * `JSON.parse` is iterative in V8 and survives well past any depth the ledger
 * accepts, but `JSON.stringify` is recursive there and gives out around depth
 * 2000. The exact point moves with how much stack the caller has already
 * spent, so it is a range rather than a constant: bisecting in a clean process
 * on Node 22 puts the first failure just above 2082, and just above 2037 with
 * 200 frames already on the stack. Either way it is far below the 5450-deep
 * script a 16,384-byte transaction can carry, so handing `stringify` the
 * object `serializeScript` builds is a dead end regardless of how that object
 * was built. This writes the JSON text directly, one
 * array or object boundary at a time, with an explicit stack standing in for
 * the call stack recursion would have used.
 *
 * The writer never needs to combine a child's result with its siblings', only
 * to emit punctuation in the right order, so unlike the tree-building walks
 * elsewhere in this file it does not need a post-order work stack: each stack
 * entry is either a node still to write or a literal closing fragment, pushed
 * so that popping them reproduces the same left-to-right, parent-before-
 * children order `JSON.stringify` would have used.
 */
export function serializeScriptToJson(script: NativeScript): string {
  type Action = { kind: 'node'; script: NativeScript } | { kind: 'text'; text: string };
  const stack: Action[] = [{ kind: 'node', script }];
  const out: string[] = [];

  while (stack.length > 0) {
    const action = stack.pop() as Action;
    if (action.kind === 'text') {
      out.push(action.text);
      continue;
    }

    const node = action.script;
    switch (node.type) {
      case 'sig':
        out.push(`{"type":"sig","keyHash":${JSON.stringify(node.keyHash)}}`);
        break;
      case 'after':
      case 'before':
        out.push(`{"type":${JSON.stringify(node.type)},"slot":${JSON.stringify(node.slot)}}`);
        break;
      case 'all':
      case 'any':
      case 'atLeast': {
        let head = `{"type":${JSON.stringify(node.type)}`;
        if (node.type === 'atLeast') head += `,"required":${JSON.stringify(node.required)}`;
        head += ',"scripts":[';
        out.push(head);

        // Pushed bottom-to-top so popping yields child[0], ',', child[1],
        // ..., child[n-1], ']}', which is the exact text order recursion
        // would have produced for this container.
        stack.push({ kind: 'text', text: ']}' });
        for (let i = node.scripts.length - 1; i >= 0; i -= 1) {
          stack.push({ kind: 'node', script: node.scripts[i] as NativeScript });
          if (i > 0) stack.push({ kind: 'text', text: ',' });
        }
        break;
      }
    }
  }

  return out.join('');
}
