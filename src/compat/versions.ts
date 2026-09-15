import type { ResolvedVersion, ToolDefinition } from './types.js';
import { compareVersions, isPrerelease, parseVersion } from './semver.js';

/**
 * Resolve which concrete versions "current", "previous" and "beta" name for a
 * tool right now, restricted to the channels the tool actually declares.
 * A channel that has no candidate (no beta ahead of the latest release, a
 * tool with only one release ever) is left out rather than filled with a
 * guess.
 */
export async function resolveVersions(tool: ToolDefinition): Promise<ResolvedVersion[]> {
  const resolved =
    tool.discovery.type === 'npm'
      ? await resolveNpmVersions(requirePackage(tool))
      : await resolveGithubReleaseVersions(tool.discovery.repo, tool.discovery.tagPrefix);
  return resolved.filter((r) => tool.channels.includes(r.channel));
}

function requirePackage(tool: ToolDefinition): string {
  if (!tool.package) {
    throw new Error(`tool "${tool.id}" uses npm discovery but has no "package"`);
  }
  return tool.package;
}

interface NpmRegistryDoc {
  versions?: Record<string, unknown>;
  'dist-tags'?: Record<string, string>;
}

async function fetchNpmRegistryDoc(pkg: string): Promise<NpmRegistryDoc> {
  const url = `https://registry.npmjs.org/${encodeNpmPackageName(pkg)}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as NpmRegistryDoc;
}

/** A scoped package name (`@meshsdk/core`) needs its slash escaped for the registry path. */
function encodeNpmPackageName(pkg: string): string {
  return pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
}

/**
 * `current` is the highest stable (non-pre-release) version published.
 * `previous` is the next stable version below it. `beta` is the highest
 * pre-release version that is itself ahead of `current`, i.e. an actual
 * preview of something not yet released, rather than a pre-release for a
 * line that has since shipped.
 */
export async function resolveNpmVersions(pkg: string): Promise<ResolvedVersion[]> {
  const doc = await fetchNpmRegistryDoc(pkg);
  const all = Object.keys(doc.versions ?? {});
  if (all.length === 0) throw new Error(`npm registry listed no versions for ${pkg}`);

  const parsed = all.map(parseVersion);
  const stable = parsed.filter((v) => !isPrerelease(v)).sort((a, b) => -compareVersions(a, b));
  const prereleases = parsed.filter(isPrerelease).sort((a, b) => -compareVersions(a, b));

  const out: ResolvedVersion[] = [];
  const current = stable[0];
  if (current) {
    out.push({ channel: 'current', version: current.raw });
    const previous = stable.find((v) => compareVersions(v, current) < 0);
    if (previous) out.push({ channel: 'previous', version: previous.raw });

    const beta = prereleases.find((v) => compareVersions(v, current) > 0);
    if (beta) out.push({ channel: 'beta', version: beta.raw });
  } else if (prereleases[0]) {
    // Every published version is a pre-release (a brand-new package that has
    // never cut a stable release). The highest one is the only thing to call
    // "current"; there is nothing to call stable yet.
    out.push({ channel: 'current', version: prereleases[0].raw });
  }
  return out;
}

interface GithubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
}

async function fetchGithubReleases(repo: string): Promise<GithubRelease[]> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'arachne-compat-watch',
  };
  // GitHub's unauthenticated rate limit is 60 requests/hour, which the daily
  // workflow run comfortably fits inside; the token, when the workflow
  // provides one, just makes local retries painless.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as GithubRelease[];
}

/**
 * `current` and `previous` are the two most recently published non-draft,
 * non-prerelease releases. `beta` is the most recently published prerelease,
 * counted only if it is newer than `current`, using GitHub's own
 * `prerelease` flag on the release rather than sniffing the tag string.
 */
export async function resolveGithubReleaseVersions(
  repo: string,
  tagPrefix: string,
): Promise<ResolvedVersion[]> {
  const releases = (await fetchGithubReleases(repo))
    .filter((r) => !r.draft)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  const stable = releases.filter((r) => !r.prerelease);
  const prereleases = releases.filter((r) => r.prerelease);

  const out: ResolvedVersion[] = [];
  const current = stable[0];
  if (current) {
    out.push({ channel: 'current', version: stripTagPrefix(current.tag_name, tagPrefix) });
    const previous = stable[1];
    if (previous)
      out.push({ channel: 'previous', version: stripTagPrefix(previous.tag_name, tagPrefix) });

    const beta = prereleases.find(
      (r) => Date.parse(r.published_at) > Date.parse(current.published_at),
    );
    if (beta) out.push({ channel: 'beta', version: stripTagPrefix(beta.tag_name, tagPrefix) });
  }
  return out;
}

function stripTagPrefix(tag: string, prefix: string): string {
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
}
