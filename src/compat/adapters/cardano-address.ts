import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeScript } from '../../model/types.js';
import type {
  HashOutcome,
  InstallOutcome,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';

/**
 * cardano-address, the CLI from `cardano-addresses`.
 *
 * Worth tracking specifically because it is an INDEPENDENT implementation of
 * the `cardano-binary` framing rule rather than a consumer of the library. It
 * carries its own copy of the 23-element threshold in `Cardano.Address.Script`
 * (`wrapArray`), so when it and cardano-cli agree that is genuine
 * corroboration; two tools sharing one encoder agreeing would not be.
 *
 * It takes a script EXPRESSION rather than JSON, so this adapter serializes
 * the AST into that grammar. The mapping was confirmed against every construct
 * the corpus uses before this adapter was written, including that `active_from`
 * is JSON `after` and `active_until` is JSON `before`, which are easy to invert.
 */
export const CARDANO_ADDRESS_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    if (tool.discovery.type !== 'github-releases') {
      throw new Error(
        `tool "${tool.id}" uses the cardano-address-binary adapter but not github-releases discovery`,
      );
    }
    const asset = `cardano-address-${version}-linux.tar.gz`;
    const base = `https://github.com/${tool.discovery.repo}/releases/download/${tool.discovery.tagPrefix}${version}`;

    let tarball: ArrayBuffer;
    let sums: string;
    try {
      tarball = await fetchBinary(`${base}/${asset}`);
      sums = await fetchText(`${base}/cardano-address-${version}-sha256sums.txt`);
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

    // This archive holds a bare `cardano-address`, unlike cardano-cli's, which
    // carries a platform suffix.
    const binaryPath = join(scratchDir, 'cardano-address');
    if (!(await pathExists(binaryPath))) {
      return {
        status: 'failed',
        error: `extracted archive for ${version} has no cardano-address binary`,
      };
    }
    await chmod(binaryPath, 0o755);

    return {
      status: 'ok',
      session: {
        hashScripts: (items: ScriptItem[]) => {
          const outcomes = new Map<string, HashOutcome>();
          for (const item of items) outcomes.set(item.id, hashOne(binaryPath, item));
          return Promise.resolve(outcomes);
        },
        // The framing rule is compiled into this binary, so the tool version is
        // the only version there is.
        resolveEngineVersion: async () => ({
          version: null,
          note: 'cardano-binary ships inside the binary and is not separately versioned',
        }),
        dispose: () => {},
      },
    };
  },
};

/**
 * The script expression grammar cardano-address accepts.
 *
 * Deliberately total over the AST: a construct this cannot express would
 * otherwise be silently skipped, and a skipped vector looks like agreement.
 * Anything unrepresentable throws here and is reported as `unsupported`.
 */
export function toScriptExpression(script: NativeScript): string {
  switch (script.type) {
    case 'sig':
      return script.keyHash;
    case 'all':
      return `all [${script.scripts.map(toScriptExpression).join(', ')}]`;
    case 'any':
      return `any [${script.scripts.map(toScriptExpression).join(', ')}]`;
    case 'atLeast':
      return `at_least ${script.required} [${script.scripts.map(toScriptExpression).join(', ')}]`;
    case 'after':
      // JSON `after` is the lower bound, which this grammar calls active_from.
      return `active_from ${script.slot}`;
    case 'before':
      return `active_until ${script.slot}`;
  }
}

function hashOne(binaryPath: string, item: ScriptItem): HashOutcome {
  let expression: string;
  try {
    expression = toScriptExpression(item.script);
  } catch (error) {
    return { status: 'unsupported', error: (error as Error).message };
  }

  // spawnSync rather than execFileSync, because this tool reports failure by
  // writing to stderr and EXITING ZERO. execFileSync therefore succeeds and
  // hands back an empty stdout, which would be recorded as a successful hash of
  // empty string. Both streams and the exit code are needed to tell the two
  // apart, and the stdout shape is checked rather than trusted.
  const run = spawnSync(binaryPath, ['script', 'hash', expression], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (run.error) {
    return { status: 'refused', error: tidyToolMessage(run.error.message) };
  }

  const stdout = (run.stdout ?? '').trim();
  if (run.status === 0 && isScriptHash(stdout)) {
    return { status: 'ok', hash: stdout };
  }

  // Verbatim, because the refusal IS the finding. cardano-address refuses a
  // different set of shapes than cardano-cli does despite following the same
  // framing rule, and that difference is only visible in these messages.
  const stderr = (run.stderr ?? '').trim();
  const detail = stderr || stdout || `exited ${run.status} with no output`;
  return { status: 'refused', error: tidyToolMessage(detail) };
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
