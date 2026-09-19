import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { AggregateTool, CompatAggregate } from '../../../src/compat/aggregate.js';
import type { CompatResult } from '../../../src/compat/result-schema.js';
import { RESULT_FORMAT_VERSION } from '../../../src/compat/result-schema.js';
import { resultPath } from '../../../src/compat/results.js';
import {
  loadSiteData,
  renderSitePages,
  resultFileStem,
  resultPagePath,
  toolPagePath,
  type SiteData,
  type VectorSummary,
} from '../../../src/compat/site/index.js';
import type { CompatVersionDocument } from '../../../src/compat/version.js';
import type { ObservedScriptsFile } from '../../../src/chain/observed.js';
import type { ChainEvidenceRecord } from '../../../src/chain/evidence.js';
import type { ToolDefinition } from '../../../src/compat/types.js';

// The site is a set of static pages rendered from committed data. These tests
// hold the deploy contract (no script, nothing fetched, every link resolves
// inside the built output) against both a small fixture, where each case can
// be stated exactly, and the real data, where the shape of what is rendered is
// whatever the corpus and the results happen to contain today.

function result(
  overrides: Partial<CompatResult> & Pick<CompatResult, 'tool' | 'version'>,
): CompatResult {
  return {
    formatVersion: RESULT_FORMAT_VERSION,
    channel: 'current',
    path: 'construct',
    engine: { id: 'engine-a', relation: 'depends', resolvedVersion: '1.0.0' },
    testedAt: '2026-09-10T00:00:00.000Z',
    corpusDigest: 'digest-one',
    arachneVersion: 'arachne@0.1.0',
    status: 'tested',
    framing: 'definite',
    vectors: [{ id: 'breadth/all-w024', status: 'agreed', hash: 'a'.repeat(56) }],
    summary: { total: 1, agreed: 1, diverged: 0, refused: 0, unsupported: 0 },
    ...overrides,
  };
}

function tool(overrides: Partial<AggregateTool> = {}): AggregateTool {
  return {
    id: 'tool-a',
    displayName: 'Tool A',
    language: 'Rust',
    usedFrom: 'JavaScript, from npm',
    homepage: 'https://example.invalid/tool-a',
    engine: { id: 'engine-a', relation: 'depends' },
    paths: ['construct', 'decode'],
    independentOf: [],
    results: [],
    ...overrides,
  };
}

const VECTOR: VectorSummary = {
  id: 'breadth/all-w024',
  family: 'breadth',
  question: 'How wide can a list be?',
  params: { tag: 'all', width: 24 },
  shape: {
    depth: 2,
    nodeCount: 25,
    sigCount: 24,
    keyHashes: [],
    timelockCount: 0,
    maxBreadth: 24,
    containerCounts: { all: 1, any: 0, atLeast: 0 },
  },
  encodingSensitive: true,
};

const OBSERVED_HASH = 'b'.repeat(56);
const TX_HASH = 'c'.repeat(64);

function observed(): ObservedScriptsFile {
  return {
    formatVersion: 1,
    scriptCount: 1,
    digest: 'observed-digest',
    scripts: [
      {
        scriptHash: OBSERVED_HASH,
        cborHex: '8201818200581c' + 'd'.repeat(56),
        scriptBytes: 34,
        decodable: true,
        framings: ['definite', 'cardanoBinary'],
        shape: VECTOR.shape,
        carriedBy: [{ network: 'preprod', txHash: TX_HASH, location: 'witness' }],
      },
    ],
  };
}

function chainEvidence(): ChainEvidenceRecord {
  return {
    formatVersion: 1,
    entryCount: 1,
    entries: [
      {
        network: 'preprod',
        accepted: true,
        txHash: TX_HASH,
        demonstrates: 'A fixture entry.',
        source: 'spec/06-chain-exercises.md, "How deep a single script can nest"',
      },
    ],
  };
}

function siteData(
  tools: AggregateTool[],
  results: Record<string, CompatResult[]>,
  overrides: Partial<SiteData> = {},
): SiteData {
  const aggregate: CompatAggregate = {
    formatVersion: 1,
    latestTestedAt: '2026-09-10T00:00:00.000Z',
    engines: [
      {
        id: 'engine-a',
        displayName: 'Engine A',
        language: 'Rust',
        homepage: 'https://example.invalid/engine-a',
      },
    ],
    tools,
  };
  const version: CompatVersionDocument = {
    formatVersion: 1,
    latestTestedAt: '2026-09-10T00:00:00.000Z',
    aggregateDigest: 'a'.repeat(64),
    toolCount: tools.length,
    resultCount: Object.values(results).flat().length,
  };
  return {
    aggregate,
    version,
    results: new Map(Object.entries(results)),
    observed: observed(),
    chainEvidence: chainEvidence(),
    vectors: new Map([[VECTOR.id, VECTOR]]),
    corpus: { vectorCount: 1, digest: 'digest-one' },
    ...overrides,
  };
}

function fixture(): SiteData {
  const a = tool();
  return siteData([a], { [a.id]: [result({ tool: a.id, version: '1.0.0' })] });
}

/** Every href and src in a page, as written. */
function links(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
}

/**
 * Resolves a relative link from one page against the set of paths the site
 * would write, and returns whether it lands on a page, a data file, or an
 * anchor that exists in the target page.
 */
function resolves(
  from: string,
  link: string,
  pages: Map<string, string>,
  dataFiles: Set<string>,
): boolean {
  if (/^(https?:)?\/\//.test(link) || link.startsWith('mailto:') || link.startsWith('data:')) {
    return true;
  }
  const [pathPart, anchor] = link.split('#') as [string, string | undefined];
  const base = from.split('/').slice(0, -1);
  let target: string;
  if (pathPart === '') {
    target = from;
  } else {
    const segments = [...base];
    for (const segment of pathPart.split('/')) {
      if (segment === '..') segments.pop();
      else if (segment !== '.' && segment !== '') segments.push(segment);
    }
    target = segments.join('/');
  }
  const page = pages.get(target);
  if (page === undefined) return dataFiles.has(target) && anchor === undefined;
  if (anchor === undefined) return true;
  return page.includes(` id="${anchor}"`);
}

describe('renderSitePages', () => {
  it('renders the home, methods and chain evidence pages, one page per tool and one per result', () => {
    const pages = renderSitePages(fixture());
    expect([...pages.keys()].sort()).toEqual([
      'chain-evidence.html',
      'index.html',
      'methods.html',
      'results/tool-a/1.0.0.html',
      'tools/tool-a.html',
    ]);
  });

  it('names a result page after the committed result file it renders', () => {
    const construct = result({ tool: 'tool-a', version: '1.0.0' });
    const decode = result({ tool: 'tool-a', version: '1.0.0', path: 'decode' });
    const onchain = result({ tool: 'tool-a', version: '1.0.0', path: 'decode-onchain' });
    for (const r of [construct, decode, onchain]) {
      const file = resultPath(r.tool, r.version, 'compat/results', r.path);
      expect(file).toBe(`compat/results/tool-a/${resultFileStem(r)}.json`);
      expect(resultPagePath(r)).toBe(`results/tool-a/${resultFileStem(r)}.html`);
    }
  });

  it('is byte-stable: rendering the same data twice produces identical pages', () => {
    const first = renderSitePages(fixture());
    const second = renderSitePages(fixture());
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('ships no script, no external stylesheet or font, and nothing the browser would fetch', () => {
    for (const [path, html] of renderSitePages(fixture())) {
      expect(html, path).not.toMatch(/<script/i);
      expect(html, path).not.toMatch(/<link[^>]+rel="stylesheet"/i);
      expect(html, path).not.toMatch(/@import/);
      expect(html, path).not.toMatch(/src="https?:/);
      expect(html, path).not.toMatch(/url\(\s*["']?https?:/);
    }
  });

  it('declares a viewport and both color schemes on every page', () => {
    for (const [path, html] of renderSitePages(fixture())) {
      expect(html, path).toContain('<meta name="viewport"');
      expect(html, path).toContain('color-scheme: light dark');
      expect(html, path).toContain('prefers-color-scheme: dark');
    }
  });

  it('escapes markup in a tool id and display name rather than injecting it', () => {
    const hostile = tool({ id: 'tool-a', displayName: '<img src=x onerror=alert(1)>' });
    const pages = renderSitePages(
      siteData([hostile], { 'tool-a': [result({ tool: 'tool-a', version: '1.0.0' })] }),
    );
    for (const [, html] of pages) {
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
    }
  });

  it('shows an untested release with the installer text it recorded, not a blank cell', () => {
    const untested = result({
      tool: 'tool-a',
      version: '2.0.0',
      status: 'untested',
      reason: 'npm ERR! 404 Not Found',
      framing: null,
      vectors: [],
      summary: { total: 0, agreed: 0, diverged: 0, refused: 0, unsupported: 0 },
    });
    const pages = renderSitePages(siteData([tool()], { 'tool-a': [untested] }));
    const page = pages.get('results/tool-a/2.0.0.html')!;
    expect(page).toContain('Could not be installed');
    expect(page).toContain('npm ERR! 404 Not Found');
    expect(pages.get('index.html')).toContain('Could not be installed');
  });

  it('keeps a mixed run and an undetermined run distinct from either framing', () => {
    const mixed = result({ tool: 'tool-a', version: '1.0.0', framing: 'mixed' });
    const undetermined = result({ tool: 'tool-a', version: '1.1.0', framing: 'undetermined' });
    const pages = renderSitePages(siteData([tool()], { 'tool-a': [mixed, undetermined] }));
    // The stylesheet defines every chip class on every page; the check is
    // about which chip the body uses.
    const body = (path: string): string => pages.get(path)!.replace(/<style[\s\S]*?<\/style>/, '');
    const mixedPage = body('results/tool-a/1.0.0.html');
    const undeterminedPage = body('results/tool-a/1.1.0.html');
    expect(mixedPage).toContain('chip-mixed');
    expect(mixedPage).not.toContain('chip-definite');
    expect(undeterminedPage).toContain('chip-undet');
    expect(undeterminedPage).not.toContain('chip-definite');
  });

  it('tells a question a tool is not asked apart from one it has no result on yet', () => {
    // Registered for construct and decode, with a result only on construct:
    // decode is pending, decode-onchain is not asked at all.
    const pages = renderSitePages(fixture());
    const home = pages.get('index.html')!;
    expect(home).toContain('Not run yet');
    expect(home).toContain('Not asked');
  });

  it('shows the language a library is written in and where it is used from', () => {
    const pages = renderSitePages(fixture());
    const page = pages.get('tools/tool-a.html')!;
    expect(page).toContain('Rust');
    expect(page).toContain('JavaScript, from npm');
  });

  it('lists a wrong hash, a refusal and an unsupported construct as separate findings on the home page', () => {
    const r = result({
      tool: 'tool-a',
      version: '1.0.0',
      vectors: [
        {
          id: 'breadth/all-w024',
          status: 'diverged',
          hash: 'e'.repeat(56),
          matchedFraming: 'neither',
        },
        { id: 'breadth/all-w024', status: 'refused', error: 'timed out' },
        { id: 'breadth/all-w024', status: 'unsupported', error: 'no negative thresholds' },
      ],
      summary: { total: 3, agreed: 0, diverged: 1, refused: 1, unsupported: 1 },
    });
    const home = renderSitePages(siteData([tool()], { 'tool-a': [r] })).get('index.html')!;
    expect(home).toContain('Wrong hash when building a script');
    expect(home).toContain('Scripts refused when building');
    expect(home).toContain('Scripts a library cannot build at all');
  });

  it('prints a refusal once per distinct wording on the tool page, not once per script', () => {
    const vectors = ['nest-linear/all-d012', 'nest-linear/all-d016', 'nest-linear/all-d024'].map(
      (id) => ({ id, status: 'refused' as const, error: 'timed out after 15000ms' }),
    );
    const r = result({
      tool: 'tool-a',
      version: '1.0.0',
      vectors,
      summary: { total: 3, agreed: 0, diverged: 0, refused: 3, unsupported: 0 },
    });
    const page = renderSitePages(siteData([tool()], { 'tool-a': [r] })).get('tools/tool-a.html')!;
    expect(page.match(/<pre>timed out after 15000ms<\/pre>/g)).toHaveLength(1);
    for (const v of vectors) expect(page).toContain(v.id);
  });

  it('says which releases a problem was seen in and which it was not', () => {
    const bad = result({
      tool: 'tool-a',
      version: '1.0.0',
      channel: 'previous',
      vectors: [{ id: 'breadth/all-w024', status: 'refused', error: 'premature end of stream' }],
      summary: { total: 1, agreed: 0, diverged: 0, refused: 1, unsupported: 0 },
    });
    const good = result({ tool: 'tool-a', version: '1.1.0' });
    const page = renderSitePages(siteData([tool()], { 'tool-a': [good, bad] })).get(
      'tools/tool-a.html',
    )!;
    expect(page.replace(/<[^>]+>/g, '')).toContain('Seen in 1.0.0; not in 1.1.0.');
  });
});

describe('renderSitePages on the committed data', () => {
  it('resolves every relative link and anchor to a page, a data file or an id in the output', async () => {
    const data = await loadSiteData();
    const pages = renderSitePages(data);
    const dataFiles = new Set([
      'aggregate.json',
      'version.json',
      'chain-evidence.json',
      'scripts.json',
    ]);
    for (const tool of data.aggregate.tools) {
      for (const r of data.results.get(tool.id) ?? []) {
        dataFiles.add(`results/${tool.id}/${resultFileStem(r)}.json`);
      }
    }
    const broken: string[] = [];
    for (const [path, html] of pages) {
      for (const link of links(html)) {
        if (!resolves(path, link, pages, dataFiles)) broken.push(`${path}: ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('renders one page per tool and one per committed result file', async () => {
    const data = await loadSiteData();
    const pages = renderSitePages(data);
    let expected = 3;
    for (const tool of data.aggregate.tools) {
      expect(pages.has(toolPagePath(tool.id)), tool.id).toBe(true);
      expected += 1 + (data.results.get(tool.id)?.length ?? 0);
    }
    expect(pages.size).toBe(expected);
  });

  it('names every library on the home page with the language it is written in', async () => {
    const data = await loadSiteData();
    const home = renderSitePages(data).get('index.html')!;
    for (const tool of data.aggregate.tools) {
      expect(home).toContain(tool.displayName);
      expect(tool.language, `${tool.id} has no language in compat/tools.json`).toBeDefined();
      expect(tool.usedFrom, `${tool.id} has no usedFrom in compat/tools.json`).toBeDefined();
    }
  });

  it('declares a language and where it is used from for every tool in compat/tools.json', async () => {
    const registry = JSON.parse(await readFile('compat/tools.json', 'utf8')) as {
      tools: ToolDefinition[];
    };
    for (const definition of registry.tools) {
      expect(definition.language, definition.id).toBeTruthy();
      expect(definition.usedFrom, definition.id).toBeTruthy();
    }
  });

  it('never prints a raw JSON identifier where the site has a word for it', async () => {
    const data = await loadSiteData();
    const pages = renderSitePages(data);
    // The methods page carries the mapping table, so it is the one page
    // allowed to print the identifiers; every other page uses the words. A
    // result file's own name (`<version>-decode-onchain.json`) is the one
    // place a path identifier legitimately shows, because that is the file.
    for (const [path, html] of pages) {
      if (path === 'methods.html') continue;
      const text = html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');
      expect(text, path).not.toMatch(/\bframing-preserving\b/);
      expect(text, path).not.toMatch(/"cardanoBinary"/);
      expect(text, path).not.toMatch(/\bdecode-onchain\b(?!\.json)/);
    }
  });
});
