# Conformance

What an implementation has to do to claim conformance, and what happens when the
reference implementation turns out to be wrong.

## Claiming conformance

A vector carries TWO encodings of the same script, `definite` and `cardanoBinary`, which
hash differently whenever a container holds 24 or more entries. Conformance is claimed
against both, or explicitly against one.

An implementation is conformant at a format version when, for every vector in a corpus
at that version, and for EACH of `encoding.definite` and `encoding.cardanoBinary`, it
reproduces:

1. That encoding's `cborHex` from `script`, as a byte comparison.
2. That encoding's `preimageHex`, which is the language tag followed by the CBOR.
3. That encoding's `scriptHash`, as blake2b-224 of the preimage.
4. Every string in the matching `credentials.definite` or `credentials.cardanoBinary`,
   for every network and role listed.

And once per vector, independent of encoding:

5. `encoding.encodingSensitive`, which is true exactly when the two hashes differ.
6. `expected` for every entry in `satisfaction`, given that entry's signers and validity
   interval. Satisfaction does not depend on framing, so this is asked once.

None of this requires a network, key material, or the ability to build a transaction.

**Checking one encoding is not conformance, and an implementation that does so must say
which.** Every field named in steps 1 to 4 exists under both encodings, so a port that
reads only `definite` finds everything it looks for, passes, and reports a green result
while never touching half of what the corpus records. A partial claim is legitimate,
because an implementation that only ever talks to JavaScript tooling may have no use for
the node's framing, but it has to be stated as partial rather than arrived at by not
looking. Report it as "conformant, definite encoding only".

Steps 5 and 6 are the ones that catch a port which skipped an encoding without meaning
to: `encodingSensitive` cannot be derived from one encoding alone.

## Three independent claims

The three questions are separable and should be reported separately. An implementation
that only ever verifies signatures against a script never needs the encoding half, and
one that only computes addresses never needs the satisfaction half. Conflating them
produces a pass or fail that nobody can act on.

| Claim             | Established by      | Needs                   |
| ----------------- | ------------------- | ----------------------- |
| Encoding          | Steps 1 to 4 above  | Nothing                 |
| Satisfaction      | Step 5 above        | Nothing                 |
| Ledger acceptance | The `onchain` array | A funded testnet wallet |

## Keeping the corpus honest

The corpus is generated, and the conformance suite regenerates it and compares. A
vector edited by hand fails on the next run. This is deliberate: the moment a vector
can be adjusted to make a test pass, it stops being evidence of anything.

Three rules follow, and they are the ones that matter.

### A rebuild never regenerates `onchain`

Scripts, encodings and reference expectations are all recomputed on every rebuild.
Chain observations are carried forward by vector id and left untouched. An observation
records what a node did; it cannot be recomputed, and replacing one costs another round
of testnet submissions.

### An observation is never fabricated

The corpus resolves a disagreement in the node's favor, which is only safe while every
observation came from a node. An observation that was never submitted carries the same
authority as one that was, and will be used to overrule correct code.

This is why `runExercise` throws rather than returning a plausible result while
transaction construction is unimplemented. A stub that returns `accepted: true` would
be worse than the missing feature.

### When a node disagrees with the reference evaluator, the node is right

The reference evaluator in [03-satisfaction.md](03-satisfaction.md) is a transcription
of the ledger's `evalTimelock`, and transcriptions can be wrong. If a chain observation
records that a node rejected a case the evaluator expects to pass, or accepted one it
expects to fail, that is a defect in this specification.

The verifier reports such a case as a `contradiction` finding, distinct in kind from an
encoding or satisfaction finding, and the conformance suite fails on it. The resolution
is to correct the evaluator, rebuild the affected vectors, and note what changed.

Editing the observation to match the expectation is the one response that is never
acceptable. It converts a real finding into a silent lie and destroys the value of
every other observation in the corpus, because a reader can no longer tell which ones
came from a node.

## Versioning

The corpus currently ships `formatVersion` 3. Version 1 carried a single flat
`encoding`; version 2 split it into the two above; version 3 added the protocol
parameters an on-chain observation was recorded under. A port refusing an unrecognized
version is behaving correctly.

[04-vector-format.md](04-vector-format.md) defines `formatVersion` and `digest`. What
matters for conformance is what an implementation does with them: refuse a
`formatVersion` you do not recognize rather than reading around the difference, because
an unknown version may have moved a field you are silently defaulting.

## Running the checks

```
npm run test:conformance    verify the committed corpus
npm run vectors:verify      the same check from the CLI, with a readable report
npm run vectors:build       regenerate, carrying observations forward
```

A failing conformance run after a generator change is expected and is fixed by
rebuilding and reviewing the diff, never by editing a vector.
