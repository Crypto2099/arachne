/**
 * Version ordering for the two schemes this package meets: npm's semver, and
 * cardano-cli's four-part `MAJOR.MINOR.PATCH.PATCH` tags. Neither the npm
 * registry's `dist-tags` nor GitHub's release list can be trusted alone to
 * name "the previous release" or "the active beta" (a `beta` dist-tag can sit
 * on a version older than `latest`, which is exactly what
 * `@emurgo/cardano-serialization-lib-nodejs` did at the time this was
 * written: `beta` pointed at `16.0.0-beta.1` while `latest` was already
 * `17.0.0`), so channel resolution orders the full version list itself.
 *
 * Precedence follows the rule in the Semantic Versioning 2.0.0 specification
 * (semver.org, "Precedence" section, item 11): compare the numeric core
 * left to right, and a version with a pre-release identifier has lower
 * precedence than the same core without one; two pre-releases compare their
 * dot-separated identifiers left to right, numeric identifiers compared
 * numerically, alphanumeric ones lexically, and a numeric identifier always
 * sorts below a non-numeric one at the same position.
 *
 * cardano-cli's tags are not valid semver (four numeric parts, not three),
 * but nothing above depends on the core having exactly three parts, so the
 * same comparator orders both schemes correctly.
 */
export interface ParsedVersion {
  core: number[];
  prerelease: string[];
  raw: string;
}

export function parseVersion(raw: string): ParsedVersion {
  const [corePart, ...prereleaseParts] = raw.split('-');
  const core = (corePart ?? '').split('.').map((part) => {
    const n = Number(part);
    if (!Number.isFinite(n)) {
      throw new Error(`"${raw}" has a non-numeric version core segment "${part}"`);
    }
    return n;
  });
  const prerelease = prereleaseParts.length === 0 ? [] : prereleaseParts.join('-').split('.');
  return { core, prerelease, raw };
}

export function isPrerelease(v: ParsedVersion): boolean {
  return v.prerelease.length > 0;
}

/** -1 if a < b, 1 if a > b, 0 if equal precedence. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  // Equal cores: no pre-release outranks any pre-release.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const preLen = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < preLen; i += 1) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    // A larger set of pre-release fields outranks a smaller one when every
    // earlier identifier tied.
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;

    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Highest-precedence version first. */
export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort((a, b) => -compareVersions(parseVersion(a), parseVersion(b)));
}
