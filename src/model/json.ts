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
      return { type: 'sig', keyHash: keyHash.toLowerCase() };
    }
    case 'all':
    case 'any': {
      return { type, scripts: parseChildren(node['scripts'], path, type) };
    }
    case 'atLeast': {
      const required = node['required'];
      if (typeof required !== 'number' || !Number.isInteger(required)) {
        throw new ScriptParseError('"required" must be an integer', path);
      }
      return { type, required, scripts: parseChildren(node['scripts'], path, type) };
    }
    case 'after':
    case 'before': {
      const slot = node['slot'];
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) {
        throw new ScriptParseError('"slot" must be a non-negative integer', path);
      }
      return { type, slot };
    }
    default:
      throw new ScriptParseError(`unknown script type "${type}"`, path);
  }
}

function parseChildren(value: unknown, path: string, tag: string): NativeScript[] {
  if (!Array.isArray(value)) {
    throw new ScriptParseError('"scripts" must be an array', path);
  }
  return value.map((child, i) => parseScript(child, `${path}/${tag}[${i}]`));
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
