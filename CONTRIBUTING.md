# Contributing

## Getting set up

```
npm install
npm run verify
```

`npm run verify` is the whole gate: lint, format, typecheck, both offline test suites,
and the corpus check. It needs no network and no configuration.

## Branching

Branch from `main`, open a pull request into `main`. CI must pass before merge.

## What changes need

A change to encoding or evaluation is not finished until it has a unit test stating the
rule in isolation, with a comment explaining why the rule is not obvious. Where the
change affects bytes, it also needs a cross-check against cardano-serialization-lib,
which is how this project knows its hand-rolled CBOR encoder is right.

A change to a generator needs the corpus rebuilt and the diff reviewed:

```
npm run vectors:build
```

## Rules that are not negotiable

The corpus is evidence. These exist to keep it that way.

**Vectors are generated, never hand-edited.** The conformance suite regenerates every
vector and compares, so a hand edit fails on the next run. If a vector is wrong, the
generator is wrong.

**A chain observation is never fabricated.** Not as a placeholder, not as a fixture, not
to make a test pass. The corpus resolves disagreements in favor of the node, which is
only safe while every observation came from a node.

**A rebuild never regenerates the `onchain` array.** Observations are carried forward by
vector id. They cannot be recomputed, and replacing one costs testnet ADA.

**When a node disagrees with the reference evaluator, the node is right.** That is a
defect in the evaluator or the specification, and it is fixed there. Editing the
observation to match the expectation is never the answer.

**Constants from a standard are read, not recalled.** A header byte, a bech32 prefix, a
size limit or a CDDL rule is quoted from the document that defines it, and the source is
named. If the source cannot be reached, the claim is marked unverified rather than
assumed.

## Adding a generator family

Every family carries a `question` it exists to answer, and that question appears in each
vector it produces. Write the question first. If it restates the family's name, there is
no family there yet.

Key hashes come from `cosigners(count, prefix)`, which derives them from a label so that
a vector reproduces in any language. Never generate one another way.

## Adding a tool to the compatibility matrix

`compat/` runs real releases of Cardano tooling against the committed corpus and records
which recorded encoding each one produces. Proposing a tool starts with
`compat/tools.json`, which separates two things: `engines`, the code that actually
produces bytes (`cardano-binary`, `cardano-serialization-lib`, `cardano-sdk-core`, and
so on), and `tools`, the things people install. Every tool entry names an `engine` and a
`relation` to it:

- `depends`: an ordinary dependency, so an upstream fix arrives when the tool bumps its
  range.
- `fork`: a forked build shipped under its own package name.
- `vendored`: a copy carried inside the package with no dependency edge.
- `reimplements`: an independent implementation of the same written rule.
- `own`: its own encoder, no shared ancestry with anything else tracked.

**State the relation honestly.** It decides what a result can be read as, not whether
the tool belongs in the matrix. `isIndependentEvidence` in `src/compat/registry.ts`
treats two tools on the same engine as one observation about that engine, however many
package names they wear. `meshsdk-core` depends on `cardano-sdk-core`, so its agreement
with another tool that also depends on `cardano-sdk-core` would establish only that the
engine is deterministic. What that same pairing actually shows is which tool has
received a given fix and when. cardano-address, by contrast, carries its own copy of the
framing rule that cardano-cli's `cardano-binary` engine follows, rather than linking the
library, so it is registered as `reimplements`, and its agreement with cardano-cli is
real corroboration. Neither relation is a judgment on the tool; each is a statement
about what its agreement or disagreement with another entry can support.

**Two paths in, and which one applies.** A tool whose API matches an adapter already in
`src/compat/adapters/` needs only a `compat/tools.json` entry. Another
cardano-serialization-lib fork sets `adapter` to `npm-csl` and names its own `package`.
Another library that exposes a single function taking this project's plain-JSON native
script shape and returning a hex hash sets `adapter` to `npm-native-script-json` and
names that export in `adapterOptions`. A tool with a genuinely different API needs a new
adapter under `src/compat/adapters/`, registered in `src/compat/adapters/index.ts`. That
second path is the normal case for a library in a language not yet represented here:
there is no existing adapter whose API a Rust or Python library happens to share.

**What an adapter does.** It installs or downloads exactly one released version of the
tool and drives that tool's own API to build a native script from the corpus's JSON
shape. It hashes the result and reports what came back, including a refusal, in the
tool's own words. Four adapters already do this and serve as templates:

- `npm-native-script-json.ts` and `csl.ts`, for a tool distributed as an npm package.
  Each installs the package into an isolated scratch directory and runs a small driver
  script next to it in a child process.
- `cardano-cli.ts` and `cardano-address.ts`, for a tool distributed as a released
  binary. Each downloads the matching release asset, verifies it against the release's
  own checksums, and shells out to the binary.
- `gouroboros.ts`, paired with `gouroboros-driver.go`, for a library in a language other
  than JavaScript. The TypeScript side installs the Go module into an isolated module
  cache and builds a small Go program from `gouroboros-driver.go`. That program is the
  one that actually imports the library, builds its structs from the corpus's JSON,
  marshals them to CBOR, and hashes the result, reporting back as a JSON array on
  stdout. The TypeScript adapter never touches the tool's native API directly, only the
  driver's file-in, JSON-on-stdout contract. This is the pattern to follow for a library
  in a new language. Write a small driver program in that language that reads the
  corpus's JSON shape from a file argument and writes a JSON array of results to stdout.
  Then write the handful of lines of TypeScript that install the toolchain, run the
  driver, and parse what it printed.

**Discovery and channels.** `discovery` says how to resolve which versions of a tool
exist. GitHub-releases discovery names a `repo` and a `tagPrefix`; npm discovery just
reads the tool's own `package` off the registry. Those are the only two types
`DiscoveryConfig` in `src/compat/types.ts` defines, and `resolveVersions` in
`src/compat/versions.ts` branches on exactly those two with no fallback. A tool
published through a registry neither covers (Packagist, crates.io, PyPI) needs a third
discovery type added to that union and a matching branch in `resolveVersions` before its
entry can resolve a version at all. That is a small addition next to writing the adapter
itself, and it is better to know it going in than to find out partway through.
`channels` says which of `current`, `previous` and `beta` to track for a tool; not every
tool has all three at a given moment, and a channel with no candidate is left out rather
than filled with a guess. A version is run once, and its result committed as a file
under `compat/results/<tool>/`. A version that later falls outside the tracked channels,
because a newer release displaced it, is not re-run; the committed result stands as the
record for that version.

**Construction paths.** `construct` builds a script from the corpus's JSON shape and
hashes the result; it is what every adapter above does by default. `decode` asks a
different question: feed the tool existing CBOR and record what it hashes, rather than
asking it to build anything. A tool can legitimately answer differently depending on
which of its own APIs is exercised; gouroboros does. A tool with that property is
registered against both `construct` and `decode` in `tools.json`'s `paths` field, and
each path is run and committed independently as its own result file.

**What to open.** A proposal names the tool, its homepage, which engine it sits on and
by what relation, and either the existing adapter it reuses or the new adapter it needs.
A result file is never hand-written or hand-edited: it comes from actually running the
tool against the committed corpus, then regenerating the summary:

```
npx tsx scripts/compat-run.ts <tool> <version> <current|previous|beta> [construct|decode]
npm run compat:aggregate
```

The corpus and the results beside it are evidence in the same sense the vectors are: a
result that was never produced by running the tool would carry the same authority as one
that was, and would be used to overrule correct code.
[compat/README.md](compat/README.md) documents the full result format and how the daily
watcher keeps it current.

## Writing

Commit messages, pull request bodies and issue bodies state what changed and why it is
correct, and stop there. No next steps, no open questions parked for a reader, no
narration of how the work went. A decision that needs a human is asked before the work
is called finished.

Plain, specific language. No em dashes, no arrow glyphs standing in for words, no emoji.

## Reporting issues

Bugs and feature requests go to the issue tracker. Security reports do not: see
[SECURITY.md](SECURITY.md).
