import { describe, expect, it } from 'vitest';
import {
  channelsFromVersionStrings,
  parseMavenMetadataVersions,
} from '../../../src/compat/versions.js';

describe('parseMavenMetadataVersions', () => {
  // Real shape of https://repo1.maven.org/maven2/com/bloxbean/cardano/cardano-client-lib/maven-metadata.xml,
  // trimmed to a few entries. Both `<latest>` and `<release>` hold a bare
  // version string too, in their own elements, not inside `<version>`; the
  // pattern must read the `<versions>` list and not those two.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.bloxbean.cardano</groupId>
  <artifactId>cardano-client-lib</artifactId>
  <versioning>
    <latest>0.8.0-preview1</latest>
    <release>0.8.0-preview1</release>
    <versions>
      <version>0.6.7</version>
      <version>0.7.0</version>
      <version>0.7.1</version>
      <version>0.7.2</version>
      <version>0.8.0-preview1</version>
    </versions>
    <lastUpdated>20260803163822</lastUpdated>
  </versioning>
</metadata>`;

  it('reads only the <versions> list, not <latest> or <release>', () => {
    expect(parseMavenMetadataVersions(xml)).toEqual([
      '0.6.7',
      '0.7.0',
      '0.7.1',
      '0.7.2',
      '0.8.0-preview1',
    ]);
  });

  it('returns an empty list for a coordinate with no versions element', () => {
    expect(parseMavenMetadataVersions('<metadata></metadata>')).toEqual([]);
  });
});

describe('channelsFromVersionStrings', () => {
  it('picks the highest stable version as current and the next as previous', () => {
    const out = channelsFromVersionStrings(['0.6.7', '0.7.0', '0.7.1', '0.7.2']);
    expect(out).toContainEqual({ channel: 'current', version: '0.7.2' });
    expect(out).toContainEqual({ channel: 'previous', version: '0.7.1' });
  });

  // Maven Central's metadata carries no separate flag for "this one is a
  // pre-release" the way GitHub's release API does; a version only counts as
  // one here because its own string has a "-" suffix, the same rule
  // `isPrerelease` applies everywhere else in this package.
  it('treats a version with a "-" suffix as a pre-release, not a channel candidate for current', () => {
    const out = channelsFromVersionStrings(['0.7.2', '0.8.0-preview1']);
    expect(out).toContainEqual({ channel: 'current', version: '0.7.2' });
    expect(out).toContainEqual({ channel: 'beta', version: '0.8.0-preview1' });
  });

  // A tag a project publishes to GitHub but never deploys to a registry
  // simply is not in this list at all, so it can never surface as "beta"
  // here the way it could from GitHub's own release history. There is
  // nothing to assert about an absent entry beyond this: the fixture omits
  // it, matching what Maven Central's own document would omit.
  it('has no beta candidate when the highest version is already stable', () => {
    const out = channelsFromVersionStrings(['0.7.1', '0.7.2']);
    expect(out.some((r) => r.channel === 'beta')).toBe(false);
  });

  it('falls back to the highest pre-release as current when nothing has shipped stable yet', () => {
    const out = channelsFromVersionStrings(['0.1.0-alpha.1', '0.1.0-alpha.2']);
    expect(out).toEqual([{ channel: 'current', version: '0.1.0-alpha.2' }]);
  });
});
