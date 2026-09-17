import { describe, expect, it } from 'vitest';
import { renderSite } from '../../../src/compat/site.js';
import type {
  AggregateResultSummary,
  AggregateTool,
  CompatAggregate,
} from '../../../src/compat/aggregate.js';
import type { CompatVersionDocument } from '../../../src/compat/version.js';

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

    const sharedOccurrences = html.split('title="shared-digest-value"').length - 1;
    expect(sharedOccurrences).toBe(2);
    expect(html).toContain('title="different-digest-value"');
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

  it('escapes a tool id containing markup rather than injecting it into the page', () => {
    const html = renderSite(
      aggregate({ tools: [tool({ id: 'tool-<img onerror=alert(1)>' })] }),
      versionDoc(),
    );
    expect(html).not.toContain('<img onerror=alert(1)>');
  });
});
