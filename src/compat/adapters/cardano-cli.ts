import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { join } from 'node:path';
import { serializeScript } from '../../model/json.js';
import type {
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';

/**
 * Downloads and verifies exactly one cardano-cli release, the same tarball
 * and `sha256sums.txt` pair `.github/workflows/ci.yml` already pins one
 * version of by hand. This generalizes that to an arbitrary version, so the
 * watcher can install whatever channel it resolved. Talking to the binary
 * itself mirrors `src/vectors/cardano-cli.ts`'s shape: a refusal is the
 * tool's verbatim stderr, not an exception.
 */
export const CARDANO_CLI_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    if (tool.discovery.type !== 'github-releases') {
      throw new Error(
        `tool "${tool.id}" uses the cardano-cli-binary adapter but not github-releases discovery`,
      );
    }
    const asset = assetName(version);
    const base = `https://github.com/${tool.discovery.repo}/releases/download/${tool.discovery.tagPrefix}${version}`;

    let tarball: ArrayBuffer;
    let sums: string;
    try {
      tarball = await fetchBinary(`${base}/${asset}`);
      sums = await fetchText(`${base}/cardano-cli-${version}-sha256sums.txt`);
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    const expected = sums
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith(asset))
      ?.split(/\s+/)[0];
    if (!expected) {
      return { status: 'failed', error: `sha256sums.txt for ${version} has no entry for ${asset}` };
    }
    const actual = createHash('sha256').update(Buffer.from(tarball)).digest('hex');
    if (actual !== expected) {
      return {
        status: 'failed',
        error: `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`,
      };
    }

    await mkdir(scratchDir, { recursive: true });
    const tarPath = join(scratchDir, asset);
    await writeFile(tarPath, Buffer.from(tarball));
    try {
      execFileSync('tar', ['-xzf', tarPath, '-C', scratchDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { stderr?: Buffer; message?: string };
      return {
        status: 'failed',
        error: (e.stderr?.toString() || e.message || 'tar extraction failed').trim(),
      };
    }
    await rm(tarPath, { force: true });

    // The archive holds a platform-suffixed binary name, matching the
    // extraction step already used in .github/workflows/ci.yml.
    const extractedPath = join(scratchDir, `cardano-cli-${platformSuffix()}`);
    const binaryPath = join(scratchDir, 'cardano-cli');
    if (await pathExists(extractedPath)) {
      await rename(extractedPath, binaryPath);
    } else if (!(await pathExists(binaryPath))) {
      return {
        status: 'failed',
        error: `extracted archive for ${version} has no cardano-cli binary`,
      };
    }
    await chmod(binaryPath, 0o755);

    return {
      status: 'ok',
      session: {
        hashScripts: (items: ScriptItem[]) => {
          const outcomes = new Map<string, HashOutcome>();
          for (const item of items) {
            outcomes.set(item.id, hashOne(binaryPath, scratchDir, item));
          }
          return Promise.resolve(outcomes);
        },
        dispose: () => {},
      },
    };
  },
};

function hashOne(binaryPath: string, scratchDir: string, item: ScriptItem): HashOutcome {
  const scriptPath = join(scratchDir, `script-${sanitize(item.id)}.json`);
  try {
    writeFileSync(scriptPath, JSON.stringify(serializeScript(item.script)), 'utf8');
    const value = execFileSync(binaryPath, ['hash', 'script', '--script-file', scriptPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
    // Guarded even though this tool exits non-zero on failure: an adapter that
    // trusts stdout records nonsense as a hash the day that changes.
    if (!isScriptHash(value)) {
      return {
        status: 'refused',
        error: tidyToolMessage(value || 'exited zero with no hash on stdout'),
      };
    }
    return { status: 'ok', hash: value };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    const text = (e.stderr || e.stdout || e.message || 'unknown failure').toString();
    // The message is the finding, so it is passed through rather than reworded.
    return { status: 'refused', error: tidyToolMessage(text) };
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assetName(version: string): string {
  return `cardano-cli-${version}-${platformSuffix()}.tar.gz`;
}

/**
 * cardano-cli's release assets are named `<arch>-<os>`, e.g.
 * `x86_64-linux`, matching Node's `arch()`/`platform()` after translating
 * Node's `x64`/`arm64` into the release naming.
 */
function platformSuffix(): string {
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };
  const osMap: Record<string, string> = { linux: 'linux', darwin: 'darwin' };
  const arch = archMap[hostArch()];
  const os = osMap[hostPlatform()];
  if (!arch || !os) {
    throw new Error(`no cardano-cli release asset known for ${hostPlatform()}/${hostArch()}`);
  }
  return `${arch}-${os}`;
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.text();
}
