import { describe, expect, it } from 'vitest';
import type { ChainEvidenceEntry, ChainEvidenceRecord } from '../../../src/chain/evidence.js';
import type { CompatAggregate } from '../../../src/compat/aggregate.js';
import {
  loadSiteData,
  renderChainEvidencePage,
  type SiteData,
} from '../../../src/compat/site/index.js';
import type { CompatVersionDocument } from '../../../src/compat/version.js';

// Mirrors the fixture helpers in test/unit/chain/record.test.ts: both match
// the nesting-depth topic by source alone, with no vectorId, so a fixture
// built from either reaches classification and rendering the same way a
// real entry would.
function acceptedEntry(overrides: Partial<ChainEvidenceEntry> = {}): ChainEvidenceEntry {
  return {
    network: 'preprod',
    accepted: true,
    txHash: 'a'.repeat(64),
    demonstrates: 'A fixture entry.',
    source: 'spec/06-chain-exercises.md, "How deep a single script can nest"',
    ...overrides,
  };
}

function refusedEntry(overrides: Partial<ChainEvidenceEntry> = {}): ChainEvidenceEntry {
  return {
    network: 'preprod',
    accepted: false,
    error: 'MaxTxSizeUTxO supplied 1 expected 0',
    demonstrates: 'A fixture entry.',
    source: 'spec/06-chain-exercises.md, "How deep a single script can nest"',
    ...overrides,
  };
}

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

function record(entries: ChainEvidenceEntry[]): ChainEvidenceRecord {
  return { formatVersion: 1, entryCount: entries.length, entries };
}

/** Site data with no libraries and no observed scripts: only the record varies. */
function data(chainEvidence: ChainEvidenceRecord): SiteData {
  const aggregate: CompatAggregate = {
    formatVersion: 1,
    latestTestedAt: null,
    engines: [],
    tools: [],
  };
  const version: CompatVersionDocument = {
    formatVersion: 1,
    latestTestedAt: null,
    aggregateDigest: 'a'.repeat(64),
    toolCount: 0,
    resultCount: 0,
  };
  return {
    aggregate,
    version,
    results: new Map(),
    observed: { formatVersion: 1, scriptCount: 0, digest: 'none', scripts: [] },
    chainEvidence,
    vectors: new Map(),
    corpus: { vectorCount: 0, digest: 'none' },
  };
}

function render(entries: ChainEvidenceEntry[]): string {
  return renderChainEvidencePage(data(record(entries)));
}

describe('renderChainEvidencePage', () => {
  it('is byte-stable: rendering the same record twice produces identical bytes', async () => {
    const loaded = await loadSiteData();
    expect(renderChainEvidencePage(loaded)).toBe(renderChainEvidencePage(loaded));
  });

  it('renders one article for every entry in the real record', async () => {
    const loaded = await loadSiteData();
    const html = renderChainEvidencePage(loaded);
    const articles = html.match(/<article class="entry edge-(ok|refused)"/g) ?? [];
    expect(articles.length).toBe(loaded.chainEvidence.entryCount);
  });

  it('anchors every accepted entry by its transaction hash, so a result page can link to it', async () => {
    const loaded = await loadSiteData();
    const html = renderChainEvidencePage(loaded);
    for (const entry of loaded.chainEvidence.entries) {
      if (entry.accepted) expect(html).toContain(`id="tx-${entry.txHash}"`);
    }
  });

  it('links an accepted entry to the same explorer URL explorerTxUrl derives', () => {
    const hash = 'b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2';
    const html = render([acceptedEntry({ txHash: hash })]);
    expect(html).toContain(`<a href="https://preprod.cexplorer.io/tx/${hash}">`);
  });

  it('renders a refused entry with its verbatim error in a preformatted block, no hash', () => {
    const html = render([refusedEntry({ error: 'MaxTxSizeUTxO supplied 1 expected 0' })]);
    expect(html).toContain('<span class="chip chip-refused">Refused</span>');
    expect(html).toContain('<pre>MaxTxSizeUTxO supplied 1 expected 0</pre>');
  });

  it('throws rather than silently omitting an accepted entry with no txHash', () => {
    expect(() => render([omit(acceptedEntry(), 'txHash')])).toThrow(/no txHash/);
  });

  it('throws rather than silently omitting a refused entry with no error', () => {
    expect(() => render([omit(refusedEntry(), 'error')])).toThrow(/no error/);
  });

  it('turns a backtick-quoted code span into a <code> element', () => {
    const html = render([acceptedEntry({ demonstrates: 'An `all []` address was spent.' })]);
    expect(html).toContain('An <code>all []</code> address was spent.');
  });

  it('links a corpus vectorId to the vector file on GitHub', () => {
    // Source overridden to one no other topic's predicate claims by prefix,
    // so this entry is classified by its vectorId alone, the same way a
    // real degenerate-threshold entry is.
    const html = render([
      acceptedEntry({
        vectorId: 'degenerate/empty-all',
        source: 'spec/03-satisfaction.md, "Degenerate thresholds"',
      }),
    ]);
    expect(html).toContain(
      '<a href="https://github.com/crypto2099/arachne/blob/main/vectors/degenerate/empty-all.json"><code>degenerate/empty-all</code></a>',
    );
  });

  it('links the spec document a source names to that file on GitHub, keeping the quoted section as text', () => {
    const html = render([acceptedEntry()]);
    expect(html).toContain(
      '<a href="https://github.com/crypto2099/arachne/blob/main/spec/06-chain-exercises.md"><code>spec/06-chain-exercises.md</code></a>, &quot;How deep a single script can nest&quot;',
    );
  });

  it('escapes markup in an entry field rather than injecting it into the page', () => {
    const html = render([acceptedEntry({ demonstrates: '<img onerror=alert(1)> was spent.' })]);
    expect(html).not.toContain('<img onerror=alert(1)>');
  });

  it('carries every topic heading the record classifies entries under', async () => {
    const loaded = await loadSiteData();
    const html = renderChainEvidencePage(loaded);
    for (const title of [
      'Degenerate thresholds',
      'Nesting depth',
      'Encoding divergence',
      'The scripts those transactions carried',
    ]) {
      expect(html).toContain(`<h2>${title}</h2>`);
    }
  });

  it('lists every observed script with the libraries that read it', async () => {
    const loaded = await loadSiteData();
    const html = renderChainEvidencePage(loaded);
    for (const script of loaded.observed.scripts) {
      expect(html).toContain(script.scriptHash.slice(0, 12));
    }
  });
});
