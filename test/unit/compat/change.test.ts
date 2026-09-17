import { describe, expect, it } from 'vitest';
import { compareResults } from '../../../src/compat/change.js';
import type { CompatResult } from '../../../src/compat/result-schema.js';

function tested(
  version: string,
  framing: CompatResult['framing'],
  vectors: CompatResult['vectors'],
  corpusDigest = 'digest',
): CompatResult {
  return {
    formatVersion: 2,
    tool: 'cardano-cli',
    version,
    channel: 'current',
    path: 'construct',
    engine: { id: 'cardano-binary', relation: 'depends', resolvedVersion: null },
    testedAt: '2026-01-01T00:00:00.000Z',
    corpusDigest,
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
    formatVersion: 2,
    tool: 'cardano-cli',
    version,
    channel: 'current',
    path: 'construct',
    engine: { id: 'cardano-binary', relation: 'depends', resolvedVersion: null },
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

const AGREED2 = {
  id: 'breadth/w4',
  status: 'agreed' as const,
  hash: 'bbbb',
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

  // The bug this whole file exists to close: `before === undefined` used to
  // take the same "skip it" branch as `before === vector.status`, so a
  // vector new since the baseline ran was silently invisible rather than
  // reported. It needs its own count and must not be read as a status
  // transition, because there is no prior status for it to have held or
  // moved away from.
  it('counts a vector with no baseline counterpart as added rather than as an unchanged status', () => {
    const a = tested('16.0.0', 'definite', [AGREED]);
    const b = tested('17.0.0', 'definite', [AGREED, AGREED2]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.details.join(' ')).toContain(
      '1 vector present in this run with no baseline counterpart',
    );
    expect(report.details.join(' ')).not.toContain('changed status');
  });

  // The mirror gap: the old code iterated only `current.vectors`, so a
  // vector the baseline had and this run does not produce at all (a crash
  // partway through a run, a tool dropping a construct it used to attempt)
  // left no trace anywhere in the report. It is worth a reader's attention
  // without being read as the tool disagreeing with itself.
  it('counts a vector present only in the baseline as missing, without marking the run changed', () => {
    const a = tested('16.0.0', 'definite', [AGREED, AGREED2]);
    const b = tested('17.0.0', 'definite', [AGREED]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.details.join(' ')).toContain('1 vector present in cardano-cli 16.0.0 missing');
  });

  // compat/README.md states the rule this enforces: two results are only
  // directly comparable when `corpusDigest` matches. Before this, a digest
  // change was read nowhere in the function at all, so a run against a
  // larger corpus than its baseline reported no qualification of any kind.
  it('names both digests in details when the corpus digest changed between the two runs', () => {
    const a = tested('16.0.0', 'definite', [AGREED], 'a6688f76');
    const b = tested('17.0.0', 'definite', [AGREED], '82c304f8');
    const report = compareResults(b, a);
    expect(report.details.join(' ')).toContain('corpus digest changed from a6688f76 to 82c304f8');
  });

  // A digest change on its own, with every shared vector holding its status,
  // is not evidence the tool behaves differently: `changed` must keep
  // meaning "a status transition on a vector both runs actually answered",
  // not "the corpus moved under one of them".
  it('is not a change from a digest change alone when every shared vector holds its status', () => {
    const a = tested('16.0.0', 'definite', [AGREED], 'a6688f76');
    const b = tested('17.0.0', 'definite', [AGREED, AGREED2], '82c304f8');
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
  });

  // "behaves the same" must never appear unqualified when the two runs were
  // not run against the same corpus, because "the same" implicitly claims to
  // speak for every vector this run touched, not just the ones old enough to
  // have been in the baseline too.
  it('qualifies the "behaves the same" headline instead of stating it plainly across a digest change', () => {
    const a = tested('16.0.0', 'definite', [AGREED], 'a6688f76');
    const b = tested('17.0.0', 'definite', [AGREED], '82c304f8');
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.headline).toContain('behaves the same');
    expect(report.headline).not.toBe(
      'cardano-cli 17.0.0 (current): behaves the same as cardano-cli 16.0.0',
    );
  });

  // `vectorKey` folds `inputFraming` into the key specifically so the decode
  // path's two entries per vector id do not collide. A regression that
  // dropped `inputFraming` from the key would make one of these two look
  // like an ordinary status hold instead of two independent additions.
  it('treats added and held vectors independently per inputFraming on the decode path', () => {
    const a = tested('16.0.0', 'definite', [
      {
        id: 'encoding-boundary/root-w24',
        status: 'agreed',
        hash: 'aaaa',
        matchedFraming: 'definite',
        inputFraming: 'definite',
      },
    ]);
    const b = tested('17.0.0', 'definite', [
      {
        id: 'encoding-boundary/root-w24',
        status: 'agreed',
        hash: 'aaaa',
        matchedFraming: 'definite',
        inputFraming: 'definite',
      },
      {
        id: 'encoding-boundary/root-w24',
        status: 'agreed',
        hash: 'bbbb',
        matchedFraming: 'cardanoBinary',
        inputFraming: 'cardanoBinary',
      },
    ]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.details.join(' ')).toContain(
      '1 vector present in this run with no baseline counterpart',
    );
  });

  // Renaming a generator family changes every id it produces, so a baseline
  // and a current run can share zero vectors while both are real, non-empty
  // results (not the `!previous` case, where there was no result at all). A
  // held `framing` or an empty transition count would both be comparisons
  // over disjoint sets of scripts, so neither supports a verdict; this must
  // read the same way as "nothing to compare against" rather than as
  // "behaves the same", which is what the ordinary path would have said.
  it('treats a baseline that shares no vector with this run as no baseline at all', () => {
    const a = tested('16.0.0', 'definite', [
      { id: 'old-family/w3', status: 'agreed', hash: 'aaaa', matchedFraming: 'both' },
    ]);
    const b = tested('17.0.0', 'definite', [
      { id: 'new-family/w3', status: 'agreed', hash: 'aaaa', matchedFraming: 'both' },
    ]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.hadBaseline).toBe(false);
    expect(report.headline).not.toContain('behaves the same');
    expect(report.headline).toContain('nothing to compare');
  });

  // A partial overlap is not the same situation: there is at least one
  // vector both runs actually answered, so a sameness claim is about that
  // vector rather than about nothing. The added/removed counts already say
  // how much of the comparison this represents, so this case gets no
  // handling beyond the counts every other case already gets.
  it('keeps the sameness headline for a partial overlap, with the counts showing how small it was', () => {
    const a = tested('16.0.0', 'definite', [AGREED, AGREED2]);
    const b = tested('17.0.0', 'definite', [
      AGREED,
      { id: 'breadth/w5', status: 'agreed', hash: 'cccc', matchedFraming: 'both' },
      { id: 'breadth/w6', status: 'agreed', hash: 'dddd', matchedFraming: 'both' },
    ]);
    const report = compareResults(b, a);
    expect(report.changed).toBe(false);
    expect(report.hadBaseline).toBe(true);
    expect(report.headline).toContain('behaves the same');
    expect(report.details.join(' ')).toContain(
      '2 vectors present in this run with no baseline counterpart',
    );
    expect(report.details.join(' ')).toContain('1 vector present in cardano-cli 16.0.0 missing');
  });
});
