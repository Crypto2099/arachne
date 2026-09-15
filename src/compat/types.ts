import type { NativeScript } from '../model/types.js';

/**
 * The version lanes worth tracking for a tool. `current` and `previous` are
 * the two most recent stable releases; `beta` is a prerelease newer than
 * `current`, when the tool has one published. Not every tool has all three at
 * a given moment, and that is recorded by simply not resolving the channel
 * rather than by inventing a version.
 */
export type Channel = 'current' | 'previous' | 'beta';

export const CHANNELS: readonly Channel[] = ['current', 'previous', 'beta'];

export type DiscoveryConfig =
  { type: 'npm' } | { type: 'github-releases'; repo: string; tagPrefix: string };

/**
 * One entry in `compat/tools.json`. `adapter` names which installer/hasher
 * pairs with this tool; `adapterOptions` carries the small amount of per-tool
 * configuration an adapter needs (an export name, an encoding quirk) so that a
 * tool sharing an existing adapter's API is a registry entry, not new code.
 */
export interface ToolDefinition {
  id: string;
  displayName: string;
  homepage: string;
  /** npm package name, for tools whose adapter or discovery is npm-based. */
  package?: string;
  adapter: string;
  adapterOptions?: Record<string, unknown>;
  discovery: DiscoveryConfig;
  channels: Channel[];
}

export interface ToolsRegistry {
  formatVersion: number;
  tools: ToolDefinition[];
}

export interface ResolvedVersion {
  channel: Channel;
  version: string;
}

/**
 * What a tool did with one script. `refused` and `unsupported` are both
 * first-class outcomes carrying the tool's verbatim text, not exceptions:
 * mirrors the rule in `src/vectors/cardano-cli.ts`, where a refusal is a
 * finding about the tooling rather than a defect to hide.
 *
 * `unsupported` is reserved for a case an adapter recognizes ahead of calling
 * the tool at all, because the tool's API cannot represent the construct
 * (distinct from `refused`, which is the tool's own runtime response to an
 * attempt that was made). No adapter in this package currently produces it;
 * every construct in the corpus has been representable in all three tools'
 * APIs, including the negative-threshold case CSL's own unit tests exclude
 * from its byte-for-byte cross-check, which resolves here as an actual
 * (surprising) hash rather than a refusal. It stays in the type because a
 * future tool is not guaranteed to share that.
 */
export type HashOutcome =
  | { status: 'ok'; hash: string }
  | { status: 'refused'; error: string }
  | { status: 'unsupported'; error: string };

export interface ScriptItem {
  id: string;
  script: NativeScript;
}

/**
 * A running instance of one tool version, holding whatever scratch state
 * (an extracted binary, an installed npm package) it needs to answer for a
 * batch of scripts. `hashScripts` takes the whole corpus at once so an
 * npm-backed adapter can pay one child-process startup cost rather than one
 * per vector; a binary-backed adapter that has no batch mode of its own can
 * still satisfy the interface by looping internally.
 */
export interface ToolSession {
  hashScripts(items: ScriptItem[]): Promise<Map<string, HashOutcome>>;
  dispose(): Promise<void> | void;
}

export type InstallOutcome =
  { status: 'ok'; session: ToolSession } | { status: 'failed'; error: string };

export interface ToolAdapter {
  /** Install exactly this version into `scratchDir` and return a session, or say why not. */
  install(tool: ToolDefinition, version: string, scratchDir: string): Promise<InstallOutcome>;
}
