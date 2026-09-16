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

/**
 * How a tool relates to the encoder that actually produces its bytes.
 *
 * Several libraries are not independent implementations at all: they are
 * consumers of a shared engine, often pinned to different versions of it. That
 * distinction decides two separate questions, and conflating them overstates
 * the evidence.
 *
 * For whether an ENCODING IS CORRECT, count engines. Three libraries wrapping
 * one engine and agreeing is one observation, not three.
 *
 * For BLAST RADIUS, count tools. One engine's behavior reaches every library
 * downstream of it, and they receive a fix at different times or never.
 *
 * - `depends`: resolves the engine as an ordinary dependency, so an upstream
 *   fix arrives when this tool bumps its range. The lag is measurable and is
 *   recorded per run.
 * - `fork`: ships a forked build of the engine under its own package name. An
 *   upstream fix may never arrive. Must be tested on its own terms.
 * - `vendored`: carries a copy inside its own package with no dependency edge
 *   at all. Same consequence as a fork, less visible.
 * - `reimplements`: an independent implementation of the same written rule.
 *   Agreement between two reimplementations is real evidence, because neither
 *   inherits the other's bugs.
 * - `own`: its own encoder, no shared ancestry with anything else tracked.
 */
export type EngineRelation = 'depends' | 'fork' | 'vendored' | 'reimplements' | 'own';

/** A shared encoder that one or more tools sit on top of. */
export interface EngineDefinition {
  id: string;
  displayName: string;
  homepage?: string;
  /** npm package name, when the engine is resolvable from a JavaScript install. */
  package?: string;
  /** For an engine that is not separately versioned, why. */
  note?: string;
}

export interface EngineLink {
  /** Engine id, matching an entry in the registry's `engines`. */
  id: string;
  relation: EngineRelation;
  /** Intermediate packages between the tool and the engine, outermost first. */
  via?: string[];
  /** For a fork or a vendored copy, the package actually shipped. */
  shippedAs?: string;
}

/**
 * Which construction path was exercised.
 *
 * `construct` builds a script from its JSON or from the tool's own builder API
 * and hashes the result. `decode` feeds the tool existing CBOR and asks for the
 * hash, which is a different question: a tool that hashes the bytes it received
 * reproduces whichever framing it was given, rather than imposing one.
 *
 * A tool can legitimately behave differently on each path, so a classification
 * is only meaningful with the path attached.
 */
export type ConstructionPath = 'construct' | 'decode';

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
  /** Which encoder actually produces this tool's bytes, and how it gets there. */
  engine: EngineLink;
}

export interface ToolsRegistry {
  formatVersion: number;
  engines: EngineDefinition[];
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
  /**
   * The engine version this install actually resolved, read from what is on
   * disk rather than from the registry.
   *
   * A declared range is not an answer: `^0.46.15` resolves at install time and
   * moves. Reading the installed copy is what lets a result say how far behind
   * upstream a tool shipped on the day it was tested. Returns null when the
   * engine is not separately versioned, which an adapter explains in `note`.
   */
  resolveEngineVersion?(): Promise<{ version: string | null; note?: string }>;
  dispose(): Promise<void> | void;
}

export type InstallOutcome =
  { status: 'ok'; session: ToolSession } | { status: 'failed'; error: string };

/**
 * What an adapter needs from the registry beyond the tool entry itself.
 *
 * `enginePackage` lets an npm-backed adapter read back which version of the
 * shared engine npm actually resolved, which a tool entry cannot state because
 * it is a property of the install rather than of the declaration.
 */
export interface InstallContext {
  enginePackage?: string;
}

export interface ToolAdapter {
  /** Install exactly this version into `scratchDir` and return a session, or say why not. */
  install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
    context?: InstallContext,
  ): Promise<InstallOutcome>;
}
