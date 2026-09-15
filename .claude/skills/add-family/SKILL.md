---
name: add-family
description: Add a generator family to the Arachne corpus. Use when a new class of native script needs covering, when a question about nesting, thresholds, timelocks or size has no vectors behind it, or when a consumer found a shape the corpus does not contain.
---

# Adding a generator family

A family is a named, parameterized generator. Families are what make the corpus
reviewable: a vector is reproducible from its family and parameters alone, so a reviewer
checks the generator once instead of reading thousands of JSON files.

## Start with the question

Every family has a `question` field, and it is not decoration. It becomes part of each
vector and of the generated index, and it is what a reader uses to decide whether the
family covers their case.

Write the question first. If it restates the family name ("does the breadth family test
breadth"), there is no family here yet. A good question names a behavior that could go
either way and that someone would be wrong about:

- "Does a repeated key hash under one threshold count once or once per occurrence?"
- "How many sub-scripts fit in one container before the transaction exceeds its size
  limit?"

## Write it

Families live in `src/generate/families.ts`. Implement `Family<P>`:

- `cases()` returns every parameter combination. Keep it finite and small enough that
  the corpus stays reviewable.
- `build(params)` returns the script. It must be a pure function of its parameters: no
  randomness, no clock, no environment.
- `id(params)` is stable and unique within the family. Pad numbers so the directory
  sorts naturally.

Key hashes come from `cosigners(count, prefix)`, which derives them from a label. Never
generate a key hash any other way, or the vector stops reproducing in a port. Give each
independent group its own prefix: two groups sharing a key changes the semantics rather
than the size.

Add the family to the `FAMILIES` array.

## Check for overlap

Two families producing the same script is duplicated coverage and wasted chain
exercises. The conformance suite has a collision check that will catch it, but predict
it first: a breadth family at width 1 and a depth family at depth 1 are usually the same
script.

## Rebuild and review

```
npm run vectors:build
npm run verify
```

Then check what you produced:

```
npx tsx src/cli.ts families
find vectors/<family> -name '*.json' -printf '%s\t%p\n' | sort -rn | head
```

Review the corpus diff with the `corpus-review` skill.

## Sizing against the limits

If the family exists to probe a limit, make sure it brackets that limit rather than
approaching it. `maxTxSize` is 16,384 bytes, so a size family needs cases on both sides.
`cborBytes` in each vector is the number to sweep. Do not assert where the limit falls
in a comment: that is what the chain exercises establish, and until one has run, the
honest statement is that the corpus brackets it.
