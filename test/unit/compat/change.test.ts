import { describe, expect, it } from 'vitest';
import { compareResults } from '../../../src/compat/change.js';
import type { CompatResult } from '../../../src/compat/result-schema.js';

function tested(
  version: string,
  framing: CompatResult['framing'],
  vectors: CompatResult['vectors'],
): CompatResult {
  return {
    formatVersion: 1,
    tool: 'cardano-cli',
    version,
    channel: 'current',
    testedAt: '2026-01-01T00:00:00.000Z',
    corpusDigest: 'digest',
    arachneVersion: 'arachne@0.1.0',
    status: 'tested',
    framing,
    vectors,
    summary: {
      total: vectors.length,
      agreed: vectors.filter((v) => v.status === 'agreed').length,
      diverged: 0,
      refused: 0,
      unsupported: 0,
    },
  };
}

function untested(version: string, reason: string): CompatResult {
  return {
    formatVersion: 1,
    tool: 'cardano-cli',
    version,
    channel: 'current',
    testedAt: '2026-01-01T00:00:00.000Z',
    corpusDigest: 'digest',
    arachneVersion: 'arachne@0.1.0',
    status: 'untested',
    reason,
    framing: null,
    vectors: [],
    summary: { total: 0, agreed: 0, diverged: 0, refused: 0, unsupported: 0 },
  };
}

const AGREED = {
  id: 'breadth/w3',
  status: 'agreed' as const,
  hash: 'aaaa',
  matchedFraming: 'both' as const,
};

describe('compareResults', () => {
  it('is not a change when there is nothing to compare against, and says so rather than claiming sameness', () => {
    const report = compareResults(tested('11.2.3.1', 'cardanoBinary', [AGREED]), undefined);
    expect(report.changed).toBe(false);
    expect(report.hadBaseline).toBe(false);
  });

  it('is not a change when framing and every vector status hold', () => {
    const a = tested('11.2.3.0', 'cardanoBinary', [AGREED]);
    const b = tested('11.2.3.1', 'cardanoBinary', [AGREED]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.hadBaseline).toBe(true);
    expect(report.headline).toContain('behaves the same');
  });

  it('is a change when the framing itself flips, the headline finding this whole watcher exists for', () => {
    const a = tested('16.0.0', 'definite', [AGREED]);
    const b = tested('17.0.0', 'cardanoBinary', [AGREED]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(true);
    expect(report.details.join(' ')).toContain('framing changed from definite to cardanoBinary');
  });

  it('is a change when a vector newly diverges even if the aggregate framing is unchanged', () => {
    const a = tested('16.0.0', 'definite', [AGREED]);
    const b = tested('17.0.0', 'definite', [
      { id: 'breadth/w3', status: 'diverged', hash: 'ffff', matchedFraming: 'neither' },
    ]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(true);
    expect(report.details.join(' ')).toContain('1 vector changed status');
    expect(report.details.join(' ')).toContain('agreed -> diverged');
  });

  it('is a change when a version that used to install stops installing', () => {
    const a = tested('11.2.3.0', 'cardanoBinary', [AGREED]);
    const b = untested(
      '11.2.3.1',
      'checksum mismatch for cardano-cli-11.2.3.1-x86_64-linux.tar.gz',
    );
    const report = compareResults(b, a);
    expect(report.changed).toBe(true);
    expect(report.headline).toContain('stopped installing');
  });

  it('is a change when a version that used to fail to install now runs', () => {
    const a = untested('11.2.2.0', 'no release asset for this platform');
    const b = tested('11.2.3.0', 'cardanoBinary', [AGREED]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(true);
    expect(report.headline).toContain('now installs and runs');
  });

  it('is not a change when a version that could not install still cannot', () => {
    const a = untested('11.2.2.0', 'network unreachable');
    const b = untested('11.2.3.0', 'network unreachable');
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
  });
});
