import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isPrerelease,
  parseVersion,
  sortVersionsDescending,
} from '../../../src/compat/semver.js';

describe('version precedence', () => {
  // Straight from the Semantic Versioning 2.0.0 spec's own worked example
  // (semver.org, "Precedence"), so the comparator is checked against the
  // exact chain the standard publishes rather than a case invented here.
  it('orders the worked example from the semver spec', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const lower = parseVersion(chain[i]!);
      const higher = parseVersion(chain[i + 1]!);
      expect(compareVersions(lower, higher)).toBeLessThan(0);
      expect(compareVersions(higher, lower)).toBeGreaterThan(0);
    }
  });

  it('compares numeric cores left to right', () => {
    expect(compareVersions(parseVersion('1.0.0'), parseVersion('2.0.0'))).toBeLessThan(0);
    expect(compareVersions(parseVersion('2.1.0'), parseVersion('2.1.1'))).toBeLessThan(0);
    expect(compareVersions(parseVersion('2.1.0'), parseVersion('2.0.9'))).toBeGreaterThan(0);
  });

  // A rule easy to get backwards: a pre-release is LOWER than the plain
  // release with the same core, not higher, even though "beta" sounds newer.
  it('ranks a release above its own pre-release', () => {
    expect(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0'))).toBeLessThan(0);
  });

  it('is not fooled by a stale npm dist-tag pointing at an old pre-release', () => {
    // What actually happened on the npm registry for
    // @emurgo/cardano-serialization-lib-nodejs: dist-tags.beta named
    // 16.0.0-beta.1 while dist-tags.latest had already moved to 17.0.0. A
    // consumer that trusts the dist-tag without checking precedence would
    // report a beta "ahead of" a release that is actually a full major
    // version behind it.
    expect(compareVersions(parseVersion('16.0.0-beta.1'), parseVersion('17.0.0'))).toBeLessThan(0);
  });

  // cardano-cli's tags are four numeric parts, not semver's three, and are
  // still ordered correctly because the comparator pads on length rather than
  // assuming exactly three segments.
  it('orders cardano-cli-style four-part versions', () => {
    expect(compareVersions(parseVersion('11.2.3.0'), parseVersion('11.2.3.1'))).toBeLessThan(0);
    expect(compareVersions(parseVersion('10.16.0.0'), parseVersion('11.0.0.0'))).toBeLessThan(0);
  });

  it('sorts a mixed list highest precedence first', () => {
    expect(sortVersionsDescending(['1.9.1', '1.9.0', '1.9.0-beta.104', '2.0.0-beta.1'])).toEqual([
      '2.0.0-beta.1',
      '1.9.1',
      '1.9.0',
      '1.9.0-beta.104',
    ]);
  });

  it('flags a version with a pre-release identifier', () => {
    expect(isPrerelease(parseVersion('1.0.0-beta.1'))).toBe(true);
    expect(isPrerelease(parseVersion('1.0.0'))).toBe(false);
  });

  it('rejects a non-numeric core segment rather than guessing at it', () => {
    expect(() => parseVersion('v1.0.0')).toThrow();
  });
});
