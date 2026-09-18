import { describe, expect, it } from 'vitest';
import { renderChainEvidenceSite } from '../../../src/compat/chain-evidence-site.js';
import { loadChainEvidence } from '../../../src/chain/evidence.js';
import type { ChainEvidenceEntry, ChainEvidenceRecord } from '../../../src/chain/evidence.js';

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

describe('renderChainEvidenceSite', () => {
  it('is byte-stable: rendering the same record twice produces identical bytes', async () => {
    const loaded = await loadChainEvidence();
    expect(renderChainEvidenceSite(loaded)).toBe(renderChainEvidenceSite(loaded));
  });

  it('renders one article for every entry in the real record', async () => {
    const loaded = await loadChainEvidence();
    const html = renderChainEvidenceSite(loaded);
    const articles = html.match(/class="entry entry-(accepted|refused)"/g) ?? [];
    expect(articles.length).toBe(loaded.entryCount);
  });

  it('links an accepted entry to the same explorer URL explorerTxUrl derives', () => {
    const hash = 'b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2';
    const html = renderChainEvidenceSite(record([acceptedEntry({ txHash: hash })]));
    expect(html).toContain(`<a href="https://preprod.cexplorer.io/tx/${hash}">`);
  });

  it('renders a refused entry with its verbatim error in a preformatted block, no hash', () => {
    const html = renderChainEvidenceSite(
      record([refusedEntry({ error: 'MaxTxSizeUTxO supplied 1 expected 0' })]),
    );
    expect(html).toContain('class="verdict verdict-refused">Refused<');
    expect(html).toContain('<pre class="error">MaxTxSizeUTxO supplied 1 expected 0</pre>');
  });

  it('throws rather than silently omitting an accepted entry with no txHash', () => {
    expect(() => renderChainEvidenceSite(record([omit(acceptedEntry(), 'txHash')]))).toThrow(
      /no txHash/,
    );
  });

  it('throws rather than silently omitting a refused entry with no error', () => {
    expect(() => renderChainEvidenceSite(record([omit(refusedEntry(), 'error')]))).toThrow(
      /no error/,
    );
  });

  it('turns a backtick-quoted code span into a <code> element', () => {
    const html = renderChainEvidenceSite(
      record([acceptedEntry({ demonstrates: 'An `all []` address was spent.' })]),
    );
    expect(html).toContain('An <code>all []</code> address was spent.');
  });

  it('links a corpus vectorId to the vector file on GitHub', () => {
    // Source overridden to one no other topic's predicate claims by prefix,
    // so this entry is classified by its vectorId alone, the same way a
    // real degenerate-threshold entry is.
    const html = renderChainEvidenceSite(
      record([
        acceptedEntry({
          vectorId: 'degenerate/empty-all',
          source: 'spec/03-satisfaction.md, "Degenerate thresholds"',
        }),
      ]),
    );
    expect(html).toContain(
      '<a href="https://github.com/crypto2099/arachne/blob/main/vectors/degenerate/empty-all.json"><code>degenerate/empty-all</code></a>',
    );
  });

  it('links the spec document a source names to that file on GitHub, keeping the quoted section as text', () => {
    const html = renderChainEvidenceSite(record([acceptedEntry()]));
    expect(html).toContain(
      '<a href="https://github.com/crypto2099/arachne/blob/main/spec/06-chain-exercises.md"><code>spec/06-chain-exercises.md</code></a>, &quot;How deep a single script can nest&quot;',
    );
  });

  it('escapes markup in an entry field rather than injecting it into the page', () => {
    const html = renderChainEvidenceSite(
      record([acceptedEntry({ demonstrates: '<img onerror=alert(1)> was spent.' })]),
    );
    expect(html).not.toContain('<img onerror=alert(1)>');
  });

  it('links back to the compat matrix, the other page on this site', async () => {
    const html = renderChainEvidenceSite(await loadChainEvidence());
    expect(html).toContain('href="index.html"');
  });

  it('has no script tag: nothing on the page fetches client-side', async () => {
    const html = renderChainEvidenceSite(await loadChainEvidence());
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('has no external stylesheet, font, or script reference', async () => {
    const html = renderChainEvidenceSite(await loadChainEvidence());
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/src=["']https?:\/\//i);
    expect(html).not.toMatch(/href=["']https?:\/\/[^"']*\.(css|woff2?|ttf)/i);
  });

  it('declares both a light and a dark color scheme rather than picking one', async () => {
    const html = renderChainEvidenceSite(await loadChainEvidence());
    expect(html).toContain('color-scheme: light dark');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });

  it('groups every real entry into a section that appears on the page', async () => {
    const loaded = await loadChainEvidence();
    const html = renderChainEvidenceSite(loaded);
    for (const heading of [
      'Degenerate thresholds',
      'Time bounds and validity intervals',
      'Malformed and out-of-range script bytes',
      'Nesting depth',
      'Multisig size ceilings',
      'Federations of federations',
      'Encoding divergence',
      'The DRep credential, end to end',
      'The stake credential, end to end',
    ]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
  });
});
