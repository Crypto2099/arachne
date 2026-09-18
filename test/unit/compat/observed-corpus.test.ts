import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadObservedCorpus } from '../../../src/compat/corpus.js';
import { toHex } from '../../../src/encode/cbor.js';
import { scriptHashFromCbor } from '../../../src/encode/decode.js';
import { encodeScript } from '../../../src/encode/script.js';
import type { NativeScript } from '../../../src/model/types.js';
import type { ObservedScriptsFile } from '../../../src/chain/observed.js';

/** 24 children, one past the boundary where the two encoders part company. */
const SPLIT: NativeScript = {
  type: 'any',
  scripts: Array.from({ length: 24 }, (_, i) => ({
    type: 'sig' as const,
    keyHash: `${String(i).padStart(2, '0')}`.repeat(28).slice(0, 56),
  })),
};

const DEFINITE = toHex(encodeScript(SPLIT, 'definite'));
const CARDANO_BINARY = toHex(encodeScript(SPLIT, 'cardanoBinary'));

function file(scripts: ObservedScriptsFile['scripts']): ObservedScriptsFile {
  return { formatVersion: 1, scriptCount: scripts.length, digest: 'setdigest', scripts };
}

describe('loadObservedCorpus', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arachne-observed-corpus-test-'));
    path = join(dir, 'scripts.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(scripts: ObservedScriptsFile['scripts']) {
    await writeFile(path, JSON.stringify(file(scripts)), 'utf8');
    return loadObservedCorpus(path);
  }

  it('records the hash the bytes have, plus what each encoder would produce from them', async () => {
    const corpus = await load([
      {
        scriptHash: scriptHashFromCbor(CARDANO_BINARY),
        cborHex: CARDANO_BINARY,
        scriptBytes: CARDANO_BINARY.length / 2,
        framings: ['cardanoBinary'],
        decodable: true,
        carriedBy: [],
      },
    ]);

    const [entry] = corpus.cases;
    expect(entry?.observedHash).toBe(scriptHashFromCbor(CARDANO_BINARY));
    expect(entry?.cardanoBinaryHash).toBe(scriptHashFromCbor(CARDANO_BINARY));
    expect(entry?.definiteHash).toBe(scriptHashFromCbor(DEFINITE));
    // The whole reason this path is worth running: the two differ here, so a
    // tool that re-encodes before hashing produces a hash that is valid for
    // the script and wrong for the bytes.
    expect(entry?.definiteHash).not.toBe(entry?.observedHash);
  });

  // A corrupted or hand-edited `scriptHash` must not be able to make a tool
  // look correct, so the hash a result is compared against is taken from the
  // bytes rather than read from the file alongside them.
  it('recomputes the observed hash from the bytes rather than trusting the file', async () => {
    const corpus = await load([
      {
        scriptHash: 'ff'.repeat(28),
        cborHex: DEFINITE,
        scriptBytes: DEFINITE.length / 2,
        framings: ['definite'],
        decodable: true,
        carriedBy: [],
      },
    ]);

    expect(corpus.cases[0]?.id).toBe(scriptHashFromCbor(DEFINITE));
    expect(corpus.cases[0]?.observedHash).toBe(scriptHashFromCbor(DEFINITE));
  });

  // `d66ed8e0` on preprod: accepted by a node, not decodable here. There is
  // no script to re-encode, so there is no comparison hash either way, and
  // the entry says so rather than reporting a hash it did not derive.
  it('carries an undecodable script with no comparison hashes', async () => {
    const undecodable = '8202821a0000000082051bffffffffffffffff';
    const corpus = await load([
      {
        scriptHash: scriptHashFromCbor(undecodable),
        cborHex: undecodable,
        scriptBytes: undecodable.length / 2,
        decodable: false,
        decodeError: 'slot out of range',
        carriedBy: [],
      },
    ]);

    expect(corpus.cases[0]?.decodable).toBe(false);
    expect(corpus.cases[0]?.definiteHash).toBeUndefined();
    expect(corpus.cases[0]?.cardanoBinaryHash).toBeUndefined();
    expect(corpus.cases[0]?.observedHash).toBe(scriptHashFromCbor(undecodable));
  });

  it('records the set digest verbatim rather than recomputing it', async () => {
    const corpus = await load([
      {
        scriptHash: scriptHashFromCbor(DEFINITE),
        cborHex: DEFINITE,
        scriptBytes: DEFINITE.length / 2,
        framings: ['definite'],
        decodable: true,
        carriedBy: [],
      },
    ]);
    expect(corpus.digest).toBe('setdigest');
  });

  it('refuses an empty set rather than reporting a tool as having agreed on nothing', async () => {
    await expect(load([])).rejects.toThrow(/no observed scripts/);
  });
});
