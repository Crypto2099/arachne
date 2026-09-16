import { readFile } from 'node:fs/promises';

/** `arachne@<version>`, matching the tag `src/cli.ts` records on a corpus rebuild. */
export async function arachneVersion(): Promise<string> {
  const url = new URL('../../package.json', import.meta.url);
  const raw = await readFile(url, 'utf8');
  const pkg = JSON.parse(raw) as { version: string };
  return `arachne@${pkg.version}`;
}
