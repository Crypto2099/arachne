import { describe, expect, it } from 'vitest';
import {
  getEngine,
  isIndependentEvidence,
  loadToolRegistry,
  RegistryError,
  toolsByEngine,
} from '../../../src/compat/registry.js';
import { toScriptExpression } from '../../../src/compat/adapters/cardano-address.js';
import { scriptTextEnvelope } from '../../../src/compat/adapters/cardano-cli.js';
import { driverEntryToHashOutcome, isScriptHash } from '../../../src/compat/adapters/hash-shape.js';
import { parseScript } from '../../../src/model/json.js';

describe('the registry models engines separately from tools', () => {
  it('links every tool to a declared engine', async () => {
    const registry = await loadToolRegistry();
    for (const tool of registry.tools) {
      expect(() => getEngine(registry, tool.engine.id), tool.id).not.toThrow();
    }
  });

  it('rejects a tool naming an engine that does not exist', async () => {
    await expect(loadToolRegistry('test/unit/compat/fixtures/unknown-engine.json')).rejects.toThrow(
      RegistryError,
    );
  });

  it('groups tools under the engine that produces their bytes', async () => {
    const registry = await loadToolRegistry();
    const grouped = toolsByEngine(registry);
    // cardano-cli and cardano-address both follow the cardano-binary rule, so
    // the table must show them together rather than as two unrelated tools.
    const haskellSide = grouped.get('cardano-binary') ?? [];
    expect(haskellSide.map((t) => t.id).sort()).toEqual(['cardano-address', 'cardano-cli']);
  });
});

describe('independent evidence', () => {
  it('does not count two tools on one engine as corroboration', async () => {
    const registry = await loadToolRegistry();
    const cli = registry.tools.find((t) => t.id === 'cardano-cli');
    const address = registry.tools.find((t) => t.id === 'cardano-address');
    const csl = registry.tools.find((t) => t.id === 'cardano-serialization-lib-nodejs');
    const mesh = registry.tools.find((t) => t.id === 'meshsdk-core');

    // Different engines: independent.
    expect(isIndependentEvidence(csl!, mesh!)).toBe(true);
    // Same engine, but cardano-address reimplements the rule rather than
    // linking the library, so agreement between them is real corroboration.
    expect(isIndependentEvidence(cli!, address!)).toBe(true);
    // A tool compared with itself is never independent evidence.
    expect(isIndependentEvidence(cli!, cli!)).toBe(false);
  });
});

describe('the hash-shape guard', () => {
  // This exists because cardano-address reports failure on stderr and exits
  // ZERO. An adapter that trusted the exit code recorded a successful hash of
  // the empty string, which surfaced as nine bogus "diverged" rows.
  it('rejects an empty string', () => {
    expect(isScriptHash('')).toBe(false);
  });

  it('rejects a message that is not a hash', () => {
    expect(isScriptHash('All keys of a script must have the same role')).toBe(false);
  });

  it('rejects a hash of the wrong length or case', () => {
    expect(isScriptHash('ab'.repeat(27))).toBe(false);
    expect(isScriptHash('AB'.repeat(28))).toBe(false);
  });

  it('accepts a real blake2b-224 hash', () => {
    expect(isScriptHash('2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f')).toBe(true);
  });
});

describe('the cardano-address script expression grammar', () => {
  // cardano-address takes an expression, not JSON. These mappings were each
  // confirmed against the tool before the adapter was written; the pair that
  // matters most is active_from/active_until, which is easy to invert.
  const key = 'aa'.repeat(28);

  it('renders each container', () => {
    expect(toScriptExpression(parseScript({ type: 'sig', keyHash: key }))).toBe(key);
    expect(
      toScriptExpression(parseScript({ type: 'all', scripts: [{ type: 'sig', keyHash: key }] })),
    ).toBe(`all [${key}]`);
    expect(
      toScriptExpression(parseScript({ type: 'any', scripts: [{ type: 'sig', keyHash: key }] })),
    ).toBe(`any [${key}]`);
    expect(
      toScriptExpression(
        parseScript({ type: 'atLeast', required: 2, scripts: [{ type: 'sig', keyHash: key }] }),
      ),
    ).toBe(`at_least 2 [${key}]`);
  });

  it('maps after to active_from and before to active_until, not the reverse', () => {
    expect(toScriptExpression(parseScript({ type: 'after', slot: 100 }))).toBe('active_from 100');
    expect(toScriptExpression(parseScript({ type: 'before', slot: 200 }))).toBe('active_until 200');
  });

  it('nests', () => {
    const script = parseScript({
      type: 'all',
      scripts: [
        { type: 'sig', keyHash: key },
        { type: 'any', scripts: [{ type: 'after', slot: 5 }] },
      ],
    });
    expect(toScriptExpression(script)).toBe(`all [${key}, any [active_from 5]]`);
  });
});

describe('the cardano-cli decode-path text envelope', () => {
  // cardano-cli's script-file reader only reaches its cborHex-decoding branch
  // once the file fails to parse as the native-script JSON grammar, which
  // requires a top-level "type" key alongside "description" and "cborHex";
  // omitting either was confirmed by hand to make cardano-cli fall through to
  // "key \"type\" not found" or an "atLeast\" script value not found" error
  // instead of decoding the bytes, so all three fields are asserted here.
  it('carries type, description and the bytes to decode', () => {
    const envelope = scriptTextEnvelope('820200581cabc');
    expect(envelope).toEqual({
      type: 'SimpleScript',
      description: '',
      cborHex: '820200581cabc',
    });
  });

  it('never truncates or reformats the hex it is given', () => {
    const cborHex = '82029f8200581c' + 'ab'.repeat(28) + 'ff';
    expect(scriptTextEnvelope(cborHex).cborHex).toBe(cborHex);
  });
});

describe('the decode-driver hash-outcome guard', () => {
  // Shared by the CSL and MeshJS decode drivers, which both report either
  // side of a decode as a plain { status, hash | error } object over a child
  // process boundary, with no HashOutcome type of their own on the other side
  // of it.
  it('accepts a real hash', () => {
    expect(
      driverEntryToHashOutcome({
        status: 'ok',
        hash: '2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f',
      }),
    ).toEqual({ status: 'ok', hash: '2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f' });
  });

  it('refuses a driver error verbatim', () => {
    expect(driverEntryToHashOutcome({ status: 'error', error: 'boom' })).toEqual({
      status: 'refused',
      error: 'boom',
    });
  });

  it('refuses a value that is not a 28-byte hash even when the driver reported ok', () => {
    // A driver bug or an unexpected return type should never surface as a
    // hash this project then treats as agreement or divergence.
    const outcome = driverEntryToHashOutcome({ status: 'ok', hash: 'not-a-hash' });
    expect(outcome.status).toBe('refused');
  });
});
