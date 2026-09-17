# chain-evidence

A machine-readable record of every real transaction submitted while writing this
project's specification, whether or not the script it carried belongs to the generated
corpus under `vectors/`.

## Authored, not generated

Everything else this project ships is either generated and checked by rebuilding it, or
carried forward by a chain exercise that records what a node actually did. This record
is neither. It is transcribed by hand from `spec/06-chain-exercises.md` and its
neighbors, each value checked against what that document states, because most of the
submissions here predate the exercise automation that would otherwise have written them
as a vector's own `onchain` observation.

Nothing regenerates `observations.json`, and nothing should. There is no
`chain-evidence:build` script and none should be added: an observation records what a
node did, it cannot be recomputed, and a hand edit that could not be told from a rebuild
would stop this file being evidence of anything. The same rule already governs a
vector's `onchain` array; see `spec/05-conformance.md`.

## Format

`observations.json` carries a `formatVersion`, an `entryCount`, and an `entries` array.
Each entry is one submission: `network`, `accepted`, `txHash` when accepted, the
ledger's verbatim `error` when refused, and `demonstrates`, saying in the source's own
terms what the submission shows. `source` names the spec document and section a value
was transcribed from, so a claim here is always traceable back to where it was stated.

An entry that corresponds to a corpus vector carries that vector's `id` as `vectorId`.
`degenerate/empty-all`, `degenerate/empty-atleast-0`, `degenerate/empty-any`,
`threshold-matrix/atleast-0-of-3` and `degenerate/atleast-negative` are the five vectors
this applies to today; their own `onchain` arrays remain the authority the verifier's
contradiction check reads, and this record only points at them. An entry without a
`vectorId` exercised a protocol limit rather than a corpus shape, for example the
depth-ceiling and multisig-ceiling exercises, whose scripts are larger than anything the
corpus generates; `shape` then carries whatever the source states about that script or
transaction: `depth`, `keyCount`, `scriptBytes`, `transactionBytes`.

`cborHex`, matching `EncodingRecord.cborHex` and `ChainObservation.cborHex`, is defined
on every entry and populated on none of them today: the spec prose this record was
transcribed from never quotes a transaction's raw bytes, and inventing one would be the
fabricated observation this project exists to avoid. A future chain exercise that
submits through `ChainProvider.submit` records it by construction, on both an
acceptance and a rejection, because a rejected transaction never reaches a chain and its
bytes cannot be recovered afterwards.

`src/chain/evidence.ts` has the loader and the validators. `test/unit/chain/evidence.test.ts`
checks this file's own shape and its agreement with the five vectors it cross-references,
as part of the default offline suite. `npm run test:koios` checks every `txHash` here
against Koios and is opt-in, since it needs a reachable network; see its own file for
why Koios rather than the Blockfrost provider the exercise code otherwise uses.

For the narrative behind each entry, read `spec/06-chain-exercises.md`,
`spec/03-satisfaction.md`, `spec/01-script-model.md` and `spec/07-encoding-divergence.md`.
This file does not repeat their tables; it only makes the same facts checkable by code.
