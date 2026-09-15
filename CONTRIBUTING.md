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

## Writing

Commit messages, pull request bodies and issue bodies state what changed and why it is
correct, and stop there. No next steps, no open questions parked for a reader, no
narration of how the work went. A decision that needs a human is asked before the work
is called finished.

Plain, specific language. No em dashes, no arrow glyphs standing in for words, no emoji.

## Reporting issues

Bugs and feature requests go to the issue tracker. Security reports do not: see
[SECURITY.md](SECURITY.md).
