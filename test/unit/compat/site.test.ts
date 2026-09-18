import { describe, expect, it } from 'vitest';
import { renderSite } from '../../../src/compat/site.js';
import type {
  AggregateResultSummary,
  AggregateTool,
  CompatAggregate,
} from '../../../src/compat/aggregate.js';
import type { CompatVersionDocument } from '../../../src/compat/version.js';

// The renderer wraps its prose at a readable source-code width, which puts a
// literal newline into the rendered HTML wherever a browser would only ever
// show a collapsed space. Assertions against a multi-word phrase pulled from
// that prose compare against whitespace-normalized text so they track what a
// reader actually sees rather than where a line happened to wrap in source.
function normalizeWhitespace(html: string): string {
  return html.replace(/\s+/g, ' ');
}

function result(overrides: Partial<AggregateResultSummary> = {}): AggregateResultSummary {
  return {
    version: '1.0.0',
    channel: 'current',
    path: 'construct',
    testedAt: '2026-09-10T00:00:00.000Z',
    corpusDigest: 'digest-one',
    arachneVersion: 'arachne@0.1.0',
    status: 'tested',
    framing: 'definite',
    summary: { total: 10, agreed: 10, diverged: 0, refused: 0, unsupported: 0 },
    resultFile: 'compat/results/tool-a/1.0.0.json',
    ...overrides,
  };
}

function tool(overrides: Partial<AggregateTool> = {}): AggregateTool {
  return {
    id: 'tool-a',
    displayName: 'Tool A',
    homepage: 'https://example.invalid/tool-a',
    engine: { id: 'engine-a', relation: 'depends' },
    paths: ['construct'],
    independentOf: [],
    results: [result()],
    ...overrides,
  };
}

function aggregate(overrides: Partial<CompatAggregate> = {}): CompatAggregate {
  return {
    formatVersion: 1,
    latestTestedAt: '2026-09-10T00:00:00.000Z',
    engines: [
      { id: 'engine-a', displayName: 'Engine A', homepage: 'https://example.invalid/engine-a' },
      { id: 'engine-b', displayName: 'Engine B' },
    ],
    tools: [tool()],
    ...overrides,
  };
}

function versionDoc(overrides: Partial<CompatVersionDocument> = {}): CompatVersionDocument {
  return {
    formatVersion: 1,
    latestTestedAt: '2026-09-10T00:00:00.000Z',
    aggregateDigest: 'a'.repeat(64),
    toolCount: 1,
    resultCount: 1,
    ...overrides,
  };
}

describe('renderSite', () => {
  it('shows latestTestedAt', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toContain('2026-09-10T00:00:00.000Z');
  });

  it('renders never rather than a blank when nothing has ever been tested', () => {
    const html = renderSite(aggregate({ latestTestedAt: null }), versionDoc());
    expect(html).toContain('never');
  });

  it('lists a tool under the engine it declares, not every engine', () => {
    const html = renderSite(
      aggregate({
        tools: [tool({ id: 'tool-a', engine: { id: 'engine-a', relation: 'depends' } })],
      }),
      versionDoc(),
    );
    const engineAIndex = html.indexOf('id="engine-engine-a"');
    const engineBIndex = html.indexOf('id="engine-engine-b"');
    const toolIndex = html.indexOf('id="tool-tool-a"');

    expect(engineAIndex).toBeGreaterThan(-1);
    expect(engineBIndex).toBeGreaterThan(-1);
    // tool-a's markup sits after engine-a's heading and before engine-b's,
    // i.e. inside engine-a's section rather than repeated under both.
    expect(toolIndex).toBeGreaterThan(engineAIndex);
    expect(toolIndex).toBeLessThan(engineBIndex);
  });

  it('shows the framing value for each result, not a rollup', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            results: [
              result({ version: '1.0.0', framing: 'definite' }),
              result({ version: '2.0.0', framing: 'cardanoBinary' }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('framing-definite">definite<');
    expect(html).toContain('framing-cardanoBinary">cardanoBinary<');
  });

  // The rule this project's compat/README.md states: a mixed or undetermined
  // framing is the finding, not noise to smooth over. If the renderer ever
  // dropped these to a shared "unclear" label, or picked one of the two
  // recorded hashes to display as if it were the answer, that would be
  // exactly the flattening compat/README.md warns against.
  it('does not flatten mixed or undetermined framing into a shared label', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            results: [
              result({ version: '1.0.0', framing: 'mixed' }),
              result({ version: '2.0.0', framing: 'undetermined' }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('framing-mixed">mixed<');
    expect(html).toContain('framing-undetermined">undetermined<');
    // Each gets its own CSS hook, so a reader (or a later change) cannot
    // accidentally style them identically to "definite" or "cardanoBinary".
    expect(html).not.toContain('framing-mixed">undetermined<');
  });

  it('renders the same corpus digest badge text for two results that share a corpusDigest', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            id: 'tool-a',
            results: [
              result({ version: '1.0.0', corpusDigest: 'shared-digest-value' }),
              result({ version: '2.0.0', corpusDigest: 'shared-digest-value' }),
            ],
          }),
          tool({
            id: 'tool-b',
            displayName: 'Tool B',
            results: [result({ version: '1.0.0', corpusDigest: 'different-digest-value' })],
          }),
        ],
      }),
      versionDoc(),
    );

    const sharedOccurrences =
      html.split('title="vectors/index.json shared-digest-value"').length - 1;
    expect(sharedOccurrences).toBe(2);
    expect(html).toContain('title="vectors/index.json different-digest-value"');
  });

  // A `decode-onchain` row is measured against the observed scripts rather
  // than the generated corpus, so its digest differs from every neighboring
  // row's. Naming the file in the badge's title is what keeps that reading as
  // a different question instead of as a corpus that moved.
  it('names the file each corpus digest belongs to', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            paths: ['construct', 'decode-onchain'],
            results: [
              result({ version: '1.0.0', path: 'construct', corpusDigest: 'vectors-digest' }),
              result({
                version: '1.0.0',
                path: 'decode-onchain',
                corpusDigest: 'observed-digest',
              }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('title="vectors/index.json vectors-digest"');
    expect(html).toContain('title="chain-evidence/scripts.json observed-digest"');
  });

  it('renders a placeholder for a tool with no results yet, not an empty table', () => {
    const html = renderSite(aggregate({ tools: [tool({ results: [] })] }), versionDoc());
    expect(html).toContain('No result recorded yet.');
  });

  it('carries an untested result forward with its reason, not silently dropped', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            results: [
              result({
                version: '99.0.0',
                status: 'untested',
                reason: 'GET https://example.invalid/99.0.0 failed with 404',
                framing: null,
              }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('untested');
    expect(html).toContain('failed with 404');
  });

  it('has no script tag: nothing on the page fetches client-side', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('has no external stylesheet, font, or script reference', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/src=["']https?:\/\//i);
    expect(html).not.toMatch(/href=["']https?:\/\/[^"']*\.(css|woff2?|ttf)/i);
  });

  it('sets a viewport meta tag for phone-width readability', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toMatch(/<meta name="viewport" content="width=device-width/);
  });

  it('declares both a light and a dark color scheme rather than picking one', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toContain('color-scheme: light dark');
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });

  it('links to the machine-readable files at the same, flat paths they are served from', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toContain('href="aggregate.json"');
    expect(html).toContain('href="version.json"');
  });

  it('links to the chain evidence record, the other page on this site', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toContain('href="chain-evidence.html"');
  });

  it('escapes a tool id containing markup rather than injecting it into the page', () => {
    const html = renderSite(
      aggregate({ tools: [tool({ id: 'tool-<img onerror=alert(1)>' })] }),
      versionDoc(),
    );
    expect(html).not.toContain('<img onerror=alert(1)>');
  });

  // Requirement: lead with the consequence in plain language before any
  // table, so a reader never has to reach a row of raw values before
  // learning why they should care which one it holds.
  it('states the two-hash consequence before any table on the page', () => {
    const html = renderSite(aggregate(), versionDoc());
    const consequenceIndex = html.indexOf('two different script hashes');
    const firstTableIndex = html.indexOf('<table');
    expect(consequenceIndex).toBeGreaterThan(-1);
    expect(firstTableIndex).toBeGreaterThan(-1);
    expect(consequenceIndex).toBeLessThan(firstTableIndex);
  });

  // Requirement: a legend defining every framing value, kept on the page
  // rather than linked away, in the reader's own words rather than the raw
  // identifier repeated back at them.
  it('defines every framing value in an on-page legend', () => {
    const html = normalizeWhitespace(renderSite(aggregate(), versionDoc()));
    expect(html).toContain('What cardano-serialization-lib, MeshJS and most JavaScript tooling');
    expect(html).toContain('What cardano-node and cardano-cli produce');
    expect(html).toContain('Only reachable on a path that hands the tool bytes');
    expect(html).toContain('Never folded into <code>definite</code>');
    expect(html).toContain('does not yet say which');
  });

  it('defines every construction path in the same legend', () => {
    const html = normalizeWhitespace(renderSite(aggregate(), versionDoc()));
    expect(html).toContain('<dt>Path: <code>construct</code></dt>');
    expect(html).toContain('<dt>Path: <code>decode</code></dt>');
    expect(html).toContain('<dt>Path: <code>decode-onchain</code></dt>');
  });

  it('states the tool and engine count once, near the top', () => {
    const html = normalizeWhitespace(
      renderSite(
        aggregate({
          tools: [
            tool({ id: 'tool-a', engine: { id: 'engine-a', relation: 'depends' } }),
            tool({ id: 'tool-b', engine: { id: 'engine-b', relation: 'own' } }),
          ],
        }),
        versionDoc({ toolCount: 2 }),
      ),
    );
    const occurrences = html.split('2 tools are tracked here, sitting on 2 independent engines');
    expect(occurrences.length - 1).toBe(1);
  });

  // Requirement: replace the line that repeated the full tool list on every
  // tool's section. When every tracked tool is independent evidence of
  // every other, as is true of every fixture above, nothing needs saying
  // per tool.
  it('carries no per-tool independence note when every tool corroborates every other', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            id: 'tool-a',
            engine: { id: 'engine-a', relation: 'depends' },
            independentOf: ['tool-b'],
          }),
          tool({
            id: 'tool-b',
            engine: { id: 'engine-b', relation: 'own' },
            independentOf: ['tool-a'],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).not.toContain('Independent evidence alongside');
    expect(html).not.toContain('class="warning"');
  });

  // Requirement: surface a warning per tool only where two tools share an
  // engine and neither reimplements the framing rule, computed from
  // `independentOf` rather than hardcoded.
  it('warns a tool that shares an engine with a tool it does not corroborate', () => {
    const html = renderSite(
      aggregate({
        engines: [{ id: 'shared-engine', displayName: 'Shared Engine' }],
        tools: [
          tool({
            id: 'tool-a',
            displayName: 'Tool A',
            engine: { id: 'shared-engine', relation: 'depends' },
            independentOf: [],
          }),
          tool({
            id: 'tool-b',
            displayName: 'Tool B',
            engine: { id: 'shared-engine', relation: 'depends' },
            independentOf: [],
          }),
        ],
      }),
      versionDoc(),
    );
    const toolAIndex = html.indexOf('id="tool-tool-a"');
    const toolBIndex = html.indexOf('id="tool-tool-b"');
    const warningIndex = html.indexOf('class="warning"', toolAIndex);
    expect(warningIndex).toBeGreaterThan(toolAIndex);
    expect(warningIndex).toBeLessThan(toolBIndex);
    expect(html.slice(toolAIndex, toolBIndex)).toContain('Tool B');
  });

  // Requirement: an explicit unmeasured state for a path a tool is not
  // registered against, filled in from the registered `paths` rather than
  // inferred from an absent row.
  it('renders an explicit unmeasured state for a path a tool is not registered against', () => {
    const html = renderSite(
      aggregate({
        tools: [tool({ paths: ['construct'], results: [result({ path: 'construct' })] })],
      }),
      versionDoc(),
    );
    expect(html).toContain('<code>decode</code> is <span class="unmeasured">unmeasured</span>');
  });

  it('says nothing extra about a path a tool is registered against and has results for', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            paths: ['construct', 'decode', 'decode-onchain'],
            results: [
              result({ path: 'construct' }),
              result({ path: 'decode' }),
              result({ path: 'decode-onchain' }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    // The legend still defines the word "unmeasured" (it is a term used
    // elsewhere on the page), but this tool's own section carries neither
    // gap note, because every one of its registered paths has a result.
    expect(html).not.toContain('is not registered against the');
    expect(html).not.toContain('has no recorded result yet');
  });

  // The verdict sentence is a function of the framing, the aggregate and the
  // tool, and of nothing that varies between one of that tool's rows and the
  // next, so a tool whose every version landed on the same side has one
  // finding, not one per version. Stating it per row put the identical
  // paragraph in every row of every table and grew with the corpus.
  it("states a tool's verdict once per distinct framing, not once per result row", () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            results: [
              result({ version: '1.0.0', framing: 'definite' }),
              result({ version: '2.0.0', framing: 'definite' }),
              result({ version: '3.0.0', framing: 'definite' }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    const occurrences = html.split('Produces the definite encoding').length - 1;
    expect(occurrences).toBe(1);
    // The raw value is still against every row: once in the overview, once on
    // the tool's own panel, and once per result.
    expect(html.split('framing-definite">definite<').length - 1).toBe(5);
  });

  it('gives a tool a panel for each framing when its results disagree', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({
            paths: ['construct', 'decode'],
            results: [
              result({ path: 'construct', framing: 'definite' }),
              result({ path: 'decode', framing: 'framing-preserving' }),
            ],
          }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('Produces the definite encoding');
    expect(html).toContain('Returned the hash of whichever bytes it was handed');
  });

  // Requirement: the reader arrives to find out which side their tool is on,
  // so the page answers that before it asks them to read a table.
  it('groups every tool by the encoding it produced before the first table', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({ id: 'tool-a', displayName: 'Tool A', results: [result({ framing: 'definite' })] }),
          tool({
            id: 'tool-b',
            displayName: 'Tool B',
            results: [result({ framing: 'cardanoBinary' })],
          }),
        ],
      }),
      versionDoc({ toolCount: 2 }),
    );
    const firstTableIndex = html.indexOf('<table');
    const overview = html.slice(0, firstTableIndex);
    expect(overview).toContain('href="#tool-tool-a"');
    expect(overview).toContain('href="#tool-tool-b"');
    expect(overview).toContain('framing-definite">definite<');
    expect(overview).toContain('framing-cardanoBinary">cardanoBinary<');
  });

  it('anchors every overview link to a section that exists on the page', () => {
    const html = renderSite(aggregate(), versionDoc());
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  // Every cell carries its own label, because below the width where seven
  // columns fit the stylesheet renders each row as labeled blocks and the
  // header row is no longer beside the value it names.
  it('labels every data cell so a narrow screen can name each value', () => {
    const html = renderSite(aggregate(), versionDoc());
    const row = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    for (const label of ['Version', 'Channel', 'Path', 'Tested', 'Corpus', 'Framing', 'Vectors']) {
      expect(row).toContain(`data-label="${label}"`);
    }
  });

  // The favicon is drawn inline as a data URI rather than fetched, which is
  // the same rule the stylesheet and the type follow.
  it('carries no off-origin reference, the favicon included', () => {
    const html = renderSite(aggregate(), versionDoc());
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
    expect(html).not.toMatch(/href=["']\/\//);
    expect(html.match(/https?:\/\//g) ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^https?:\/\/$/)]),
    );
  });

  // Requirement: a plain-English verdict alongside the raw framing value,
  // naming which other tracked tool currently lands on the same side.
  it('names another tracked tool that currently produces the same encoding', () => {
    const html = renderSite(
      aggregate({
        tools: [
          tool({ id: 'tool-a', displayName: 'Tool A', results: [result({ framing: 'definite' })] }),
          tool({ id: 'tool-b', displayName: 'Tool B', results: [result({ framing: 'definite' })] }),
        ],
      }),
      versionDoc(),
    );
    expect(html).toContain('Produces the definite encoding');
    expect(html).toContain('also produced by Tool B');
  });
});
