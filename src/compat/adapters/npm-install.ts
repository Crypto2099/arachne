import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

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
 * `dir`. The driver reads a JSON array of `{ id, script }` from the path in
 * `argv[2]` and writes a JSON array of `DriverBatchOutputEntry` to stdout, so
 * one child process pays for the whole corpus rather than one per vector.
 *
 * The driver is spawned as a plain Node process rather than imported into
 * this one: the scratch install can pull in a different major version of the
 * same library this project already depends on for its own cross-checks, and
 * two copies of a native/WASM binding sharing a process is a hazard worth not
 * taking.
 */
export function runDriverBatch(
  driverPath: string,
  inputPath: string,
): { status: 'ok'; entries: DriverBatchOutputEntry[] } | { status: 'failed'; error: string } {
  try {
    const stdout = execFileSync('node', [driverPath, inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 'ok', entries: JSON.parse(stdout) as DriverBatchOutputEntry[] };
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
