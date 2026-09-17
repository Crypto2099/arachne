import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type NpmInstallOutcome = { status: 'ok' } | { status: 'failed'; error: string };

/**
 * Install exactly `pkg@version` into `dir`, isolated from any other
 * `node_modules`. A `package.json` is written first so npm does not walk up
 * looking for a workspace root and pull the install somewhere unexpected.
 */
export async function installNpmPackage(
  pkg: string,
  version: string,
  dir: string,
): Promise<NpmInstallOutcome> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${dir}/package.json`,
    `${JSON.stringify({ name: 'arachne-compat-scratch', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  try {
    execFileSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--no-save', '--no-package-lock', `${pkg}@${version}`],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 },
    );
    return { status: 'ok' };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const text = (
      e.stderr?.toString() ||
      e.stdout?.toString() ||
      e.message ||
      'unknown npm failure'
    )
      .toString()
      .trim();
    return { status: 'failed', error: text };
  }
}

export interface DriverBatchInput {
  id: string;
  script: unknown;
}

export type DriverBatchOutputEntry =
  { id: string; status: 'ok'; hash: string } | { id: string; status: 'error'; error: string };

/**
 * Run a driver script that was installed alongside `pkg`'s `node_modules` in
 * `dir`. The driver reads a JSON array of its input shape from the path in
 * the last argument and writes a JSON array to stdout, so one child process
 * pays for the whole corpus rather than one per vector. `extraArgs`, when
 * given, are inserted before `inputPath` on the driver's own `argv`; a driver
 * that answers for more than one construction path, or that needs to know
 * which package it was installed as, reads them out itself (see
 * `cml-driver.mjs` and `native-script-classes-driver.mjs`, which both take a
 * mode and a package name this way rather than hard-coding either).
 *
 * The type parameter is the shape of one entry in the driver's own output
 * array; it defaults to `DriverBatchOutputEntry` because that is every
 * existing driver's shape, and a driver answering a differently-shaped
 * question (the decode path's `{ id, definite, cardanoBinary }`) names its
 * own at the call site instead.
 *
 * The driver is spawned as a plain Node process rather than imported into
 * this one: the scratch install can pull in a different major version of the
 * same library this project already depends on for its own cross-checks, and
 * two copies of a native/WASM binding sharing a process is a hazard worth not
 * taking.
 */
export function runDriverBatch<T = DriverBatchOutputEntry>(
  driverPath: string,
  inputPath: string,
  extraArgs: string[] = [],
): { status: 'ok'; entries: T[] } | { status: 'failed'; error: string } {
  try {
    const stdout = execFileSync('node', [driverPath, ...extraArgs, inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 'ok', entries: JSON.parse(stdout) as T[] };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const text = (
      e.stderr?.toString() ||
      e.stdout?.toString() ||
      e.message ||
      'unknown driver failure'
    )
      .toString()
      .trim();
    return { status: 'failed', error: text };
  }
}

/**
 * The version of `pkg` actually resolved inside `dir`, read from the installed
 * package.json rather than from any declared range.
 *
 * This is how a result records the engine a library shipped on the day it was
 * tested. A registry entry can only say `^0.46.15`; what npm resolved that to
 * is a fact about the install, and it is the number that decides whether an
 * upstream fix has reached anyone.
 *
 * Returns null with a note rather than throwing when the package is not
 * present, since a missing engine is a finding about the tool's dependency
 * tree, not a failure of the run.
 */
export async function resolveInstalledVersion(
  pkg: string,
  dir: string,
): Promise<{ version: string | null; note?: string }> {
  const manifest = join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
  try {
    const raw = await readFile(manifest, 'utf8');
    const version = (JSON.parse(raw) as { version?: string }).version;
    if (typeof version !== 'string') {
      return { version: null, note: `${pkg} package.json has no version field` };
    }
    return { version };
  } catch (error) {
    return {
      version: null,
      note: `${pkg} not found under ${dir}/node_modules: ${(error as Error).message}`,
    };
  }
}
