import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { CorpusIndex, Vector } from './schema.js';

export const DEFAULT_CORPUS_DIR = 'vectors';

export async function loadIndex(dir = DEFAULT_CORPUS_DIR): Promise<CorpusIndex> {
  const raw = await readFile(join(dir, 'index.json'), 'utf8');
  return JSON.parse(raw) as CorpusIndex;
}

export async function loadVector(id: string, dir = DEFAULT_CORPUS_DIR): Promise<Vector> {
  const raw = await readFile(join(dir, `${id}.json`), 'utf8');
  return JSON.parse(raw) as Vector;
}

/** Every vector on disk, sorted by id, regardless of what the index claims. */
export async function loadAllVectors(dir = DEFAULT_CORPUS_DIR): Promise<Vector[]> {
  if (!existsSync(dir)) return [];
  const files = await walk(dir);
  const vectors = await Promise.all(
    files
      .filter((f) => f.endsWith('.json') && relative(dir, f) !== 'index.json')
      .map(async (f) => JSON.parse(await readFile(f, 'utf8')) as Vector),
  );
  return vectors.sort((a, b) => a.id.localeCompare(b.id));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Write the corpus, carrying forward every chain observation already on disk.
 *
 * A rebuild regenerates scripts, encodings and reference expectations. It must
 * never regenerate `onchain`, which is evidence from a real node that cannot be
 * recomputed and would cost another round of testnet submissions to replace.
 * Observations are keyed by vector id and merged back in.
 */
export async function writeCorpus(
  vectors: Vector[],
  index: CorpusIndex,
  dir = DEFAULT_CORPUS_DIR,
): Promise<{ written: number; observationsCarried: number }> {
  const existing = await loadAllVectors(dir);
  const priorObservations = new Map(existing.map((v) => [v.id, v.onchain ?? []]));

  let observationsCarried = 0;
  const merged = vectors.map((vector) => {
    const prior = priorObservations.get(vector.id) ?? [];
    observationsCarried += prior.length;
    return { ...vector, onchain: prior };
  });

  for (const vector of merged) {
    const path = join(dir, `${vector.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(vector, null, 2)}\n`, 'utf8');
  }

  const rebuiltIndex: CorpusIndex = {
    ...index,
    observationCount: observationsCarried,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.json'),
    `${JSON.stringify(rebuiltIndex, null, 2)}\n`,
    'utf8',
  );

  return { written: merged.length, observationsCarried };
}

/** Record a chain observation against a vector already on disk. */
export async function appendObservation(
  id: string,
  observation: Vector['onchain'][number],
  dir = DEFAULT_CORPUS_DIR,
): Promise<void> {
  const vector = await loadVector(id, dir);
  vector.onchain = [...(vector.onchain ?? []), observation];
  const path = join(dir, `${id.split('/').join(sep)}.json`);
  await writeFile(path, `${JSON.stringify(vector, null, 2)}\n`, 'utf8');
}
