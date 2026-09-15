# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Arachne is a harness and conformance corpus for Cardano native scripts, built to
establish what combinations are actually possible on chain: nesting depth, threshold
shapes, timelock behavior, and size limits, across payment, staking and DRep
credentials. Ekklesia and Onboard Ninja are the intended consumers, and the corpus is
language-neutral so a PHP port can assert against the same data as the TypeScript one.

The value of the project is that everything it records is either derivable from a
published standard or observed from a real node, and that a reader can tell which.
Any change that blurs that line is a bad change however well it tests.

## Commands

```
npm run verify            lint, format, typecheck, offline suites, corpus check
npm test                  the unit and conformance suites
npm run test:cli          cross-check the corpus against cardano-cli
npm run test:unit         one suite
npm run test:conformance  one suite
npx vitest run -t 'name'  one test by name
npx vitest run test/unit/encode.test.ts    one file
npm run vectors:build     regenerate the corpus, carrying observations forward
npm run vectors:verify    re-derive every vector and report disagreements
npm run build             emit dist/
```

`npm run test:chain` is where the chain exercises will submit real transactions to
preview or preprod and spend testnet ADA. None are implemented, so the project currently
contains no tests and the command runs nothing. It is a separate vitest project, is
never part of the default run, and needs the configuration in `.env.example`.

The CLI is useful while debugging:

```
npx tsx src/cli.ts inspect script.json
npx tsx src/cli.ts evaluate script.json --signer <keyHash> --start <slot>
npx tsx src/cli.ts families
```

## Architecture

Three independent things are checked, and keeping them apart is the central design
decision. They fail for different reasons and are proved by different means.

| Layer           | Question                       | Needs a network |
| --------------- | ------------------------------ | --------------- |
| `src/encode/`   | Same CBOR and script hash?     | No              |
| `src/evaluate/` | Same verdict on a witness set? | No              |
| `src/chain/`    | Does a node accept it?         | Yes             |

`src/model/` is the AST and the JSON parser. `src/generate/` produces scripts from
parameterized families. `src/vectors/` builds, loads and verifies the corpus, and is the
public conformance API. Everything flows one way: model, encode and evaluate, then
generate, then vectors.

### A script has two valid hashes, and that is the central fact

`cardano-binary`, under cardano-node and cardano-cli, frames a sub-script list as a
definite-length CBOR array up to 23 children and an indefinite-length array from 24 up.
cardano-serialization-lib and most JavaScript tooling use definite length at every size.
So a container with 24 or more children has two valid encodings, two valid hashes, two
valid addresses and two valid governance identifiers.

Neither is canonical. Every vector records both under `encoding.definite` and
`encoding.cardanoBinary`, with `encodingSensitive` saying whether they differ, and
`credentials` carries a set per encoding. `scriptHashes(script)` returns both.

The safe primitive for a script that arrives as bytes is `scriptHashFromCbor`, which
hashes what was received. Decoding and re-encoding can change the framing and therefore
the hash. `decodeScript` reports which framings reproduce the bytes it read, and an
empty `framings` array means neither standard encoder produces them, so re-encoding is
unsafe. Full account in `spec/07-encoding-divergence.md`.

### Three oracles, deliberately

| Oracle                      | Implements         | Authority                                              |
| --------------------------- | ------------------ | ------------------------------------------------------ |
| `cardano-cli`               | `cardanoBinary`    | Shares cardano-api's serialization path with the node  |
| `cardano-serialization-lib` | `definite`         | Independent Rust implementation, what most wallets run |
| The ledger source           | Satisfaction rules | `evalTimelock`, transcribed                            |

cardano-cli is the strongest, so the `cli` vitest project pins the node side and the CSL
cross-check pins the ecosystem side. Agreeing with both is worth more than either. The
`cli` project skips cleanly when the binary is absent and CI installs a pinned version.

### The CBOR encoder is hand-rolled on purpose

`src/encode/cbor.ts` does not use a CBOR library. The encoding is the thing under test,
and a port has to reproduce it from a written rule, so the rules have to be small enough
to read in full. Correctness is established by cross-checking against
cardano-serialization-lib over the entire corpus in `test/unit/csl-crosscheck.test.ts`.
If those disagree, this implementation is wrong.

### The corpus is generated, and that is what makes it evidence

`vectors/` is committed and shipped in the package. The conformance suite regenerates
every vector and compares, so a hand-edited vector fails on the next run. If a vector is
wrong, the generator is wrong.

### The reference evaluator is a transcription, not an opinion

`src/evaluate/evaluate.ts` transcribes `evalTimelock` from the ledger
(`eras/allegra/impl/src/Cardano/Ledger/Allegra/Scripts.hs` in `IntersectMBO/cardano-ledger`).
Three of its rules are where implementations go wrong, and each is stated in
`spec/03-satisfaction.md` with the failure it causes:

- A threshold counts satisfied sub-scripts, not distinct keys. A duplicated key under
  one `atLeast` counts twice.
- Nesting does not flatten. Accumulating key hashes up the tree turns "one of A or B,
  plus C" into "A and B and C".
- A timelock against an absent validity interval bound fails. It is not skipped and not
  neutral.

The existing `getScriptCriteria` in `ekklesia-helpers` flattens and ignores timelocks,
which is the concrete reason this project exists.

### The corpus is checked for discriminating power

`test/conformance/discriminating-power.test.ts` implements the flattening evaluator, the
one that accumulates key hashes up the tree and skips timelocks, and requires the corpus
to catch it. 125 of 973 satisfaction cases currently disagree with it, concentrated in
the families built for that purpose:

| Family                                       | Cases that discriminate |
| -------------------------------------------- | ----------------------- |
| `federation-of-federations`                  | 45%                     |
| `timelocks`                                  | 43%                     |
| `duplicate-keys`                             | 38%                     |
| `federation`                                 | 30%                     |
| `nested-threshold`                           | 18%                     |
| `breadth`, `nest-linear`, `threshold-matrix` | 0%                      |

The zeroes are correct rather than a gap. A flat script has nothing to flatten and no
timelock to skip, so those families earn their place on the encoding and size questions
instead. If one of the non-zero rows ever drops to zero, coverage has been lost and the
family that provided it needs looking at.

## Invariants that must not be weakened

These exist because the corpus is evidence rather than fixtures. Changing one is a
deliberate decision carried by a human, not a refactor.

- **A chain observation is never fabricated.** Not as a placeholder, not to make a test
  pass. An observation that was never submitted carries the same authority as one that
  was and will be used to overrule correct code. `runExercise` throws while transaction
  construction is unimplemented; leave it throwing rather than returning a plausible
  result.
- **A rebuild never regenerates `onchain`.** Observations are carried forward by vector
  id in `writeCorpus`. They cannot be recomputed and replacing one costs testnet ADA.
- **When a node disagrees with the reference evaluator, the node is right.** The
  verifier reports this as a `contradiction`, distinct from an encoding or satisfaction
  finding. Fix the evaluator and rebuild. Never edit the observation.
- **Constants from a standard are read, not recalled.** Header bytes, bech32 prefixes,
  size limits and CDDL rules are quoted from the document that defines them, with the
  source named in a comment or in `spec/`. This covers CIPs and the ledger equally. If a
  source cannot be reached, mark the claim unverified rather than assuming it.

## Known defects

**Recursion limits in this implementation.** `parseScript` throws a `RangeError` at
around depth 1800 and `evaluate` at around 2048, while `encodeScript` survives to about 6000. The deepest linear `all` that fits in a 16,384-byte transaction is 5450, and
cardano-cli handled 4096 without complaint, so scripts the ledger would accept crash
this library. The tree walks are recursive and need converting to explicit stacks. This
is exactly the unspecified-implementation-limit risk the spec describes, found here.

## Known limits, and where they come from

No recursion limit is specified anywhere. The CDDL is directly recursive through
`script_all = (1, [* native_script])` with no depth bound, the ledger's evaluator has no
depth counter, and the decoder has no nesting limit. What binds is size, and there are
two ceilings depending on delivery:

| Route                     | Bound                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| Inline in the witness set | `maxTxSize`, 16,384 bytes, confirmed live on mainnet and preview  |
| Reference script          | 204,800 bytes per transaction, 1 MiB per block, plus a tiered fee |

A single script is bounded by `maxTxSize` either way, because a reference script has to
be created first and the creating transaction carries it in an output. The 200 KiB
budget buys many scripts in one transaction, not one larger script. `src/chain/bundle.ts`
does that arithmetic, including the tiered reference script fee transcribed from
`tierRefScriptFee`.

The residual risk is the unspecified limits: a stack bound in a wallet, an indexer or a
serialization library is written down nowhere and will differ between them. That is what
the depth and federation families exist to find, and it can only be found by submitting.

## Testing expectations

A change to encoding or evaluation needs a unit test stating the rule in isolation with
a comment saying why the rule is not obvious, plus a CSL cross-check where bytes are
affected, plus a corpus rebuild with the diff reviewed where generated scripts change.

A new generator family names the question it answers in its `question` field. If you
cannot state a question the family answers, the family should not exist. The
`add-family` and `corpus-review` skills in `.claude/skills/` cover both procedures.

## Public documents

Anything a reader outside this repository will see goes through the editor skill before
it is committed: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, everything in `spec/`,
pull request bodies and issue bodies. Re-run it whenever the document changes, because a
pass describes the version it read and nothing else.

## Working practice

Repository work happens in a git worktree, never in the primary checkout. Two
`PreToolUse` hooks in `.claude/hooks/` enforce this for subagents along with scratchpad
namespacing; the main session is exempt as the single coordinator.

Branch from `main` and open a pull request into `main`. CI must pass. Merging is the
maintainer's.

Commit messages and pull request bodies state what changed and why it is correct, and
stop there. No next steps, no open questions parked for a reader, no narration of how
the work went. A decision that needs a human is asked before the work is called
finished. Plain language, no em dashes, no arrow glyphs standing in for words, no emoji.
Never mention AI, an agent, or anything under `.claude/` in a commit, pull request,
issue or code comment, and never add authorship or attribution trailers.
