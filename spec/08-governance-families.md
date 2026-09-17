# Governance families

Five generator families, each modeling a published decision rule from a real
deliberative or governance body rather than sweeping a parameter for its own sake.
`nested-threshold`, `federation` and `federation-of-federations` already establish that
nesting does not flatten and that duplicate keys are counted, not deduplicated, but they
do it with cohorts that are uniform by construction: every member the same size, every
internal threshold the same fraction. Real bodies are not uniform, and the families here
each depart from uniformity in a way one specific published rule actually does.

## What ties them together

Every number in this document is read from somewhere: a CIP, a mainnet configuration
file, a national constitution, or a state's corporation statute. Where a family's own
doc comment in `src/generate/families.ts` already cites the source inline, this document
does not repeat the citation, only the reasoning for the modeling choice built on top of
it. Two choices recur across more than one family and are stated once here.

**A vote is a signature.** Each governance body below casts votes, not signatures, and a
native script only sees signatures. Every family treats "this member's `Yes` vote is present"
as "this member's key witnessed the transaction". That is exact for a body where each
member genuinely casts one vote (the constitutional committee, the UN Security Council),
and an approximation everywhere voting is by proxy, by stake or in two steps of quorum
then majority (DReps and SPOs in `conway-ratification`, shareholders in
`weighted-voting`). The approximation is named in the affected family's own doc comment
rather than silently assumed.

**Weight is repeated key hashes.** A native script has no weight field anywhere in its
grammar. The only way to give one signer's `Yes` more effect than another's is to make
that signer satisfy more sub-scripts than one, which means repeating their key hash as
several `sig` children under the same threshold. [03-satisfaction.md](03-satisfaction.md)
already states the rule this relies on: `isValidMOf` counts satisfied sub-scripts, not
distinct keys, so `atLeast(2, [sig(A), sig(A)])` is satisfied by `A` alone.
`duplicate-keys` proves that rule with one key repeated under one threshold.
`weighted-voting` and the
DRep and SPO cohorts in `conway-ratification` are that same rule applied to several
different signers, each repeated a different number of times, which is the shape that
actually arises once voting power is proportional to holdings rather than headcount.

## The five families

### `constitutional-committee`

Cardano's own constitutional committee, the one body in this document whose members
genuinely cast one vote each, so it is the one family here that translates without
approximation. Two cases: CIP-1694's own worked example of how an expired member is
excluded from the count, and the committee actually seated at the Conway (Chang) hard
fork, seven members at a two-thirds threshold, read from mainnet's own genesis
configuration.

### `conway-ratification`

A governance action's ratification rule, which CIP-1694 states is always a conjunction
of two or three governance bodies, never a choice between them, each meeting its own
published threshold. The committee cohort is Cardano's real size, seven. The DRep and
SPO thresholds are mainnet's real published ratios, applied to a fixed illustrative
headcount standing in for an unbounded, stake-weighted electorate this corpus has no way
to represent faithfully. This is the family that puts a small, exactly-sized executive
body and a much larger approximated one under the same top-level `all`, which is the
"large assembly and small executive" shape a uniform federation cannot produce.

### `un-security-council`

Article 27 of the UN Charter gives the Security Council two different rules over the
same fifteen members: any nine for a procedural matter, nine including the concurring
vote of all five permanent members for anything else. The `substantive` case requires
each permanent member's key hash to appear twice, once in the pooled count and once in
its own five-of-five branch, so one signature has to satisfy two sub-scripts at once.
That is the sub-script-counting rule from [03-satisfaction.md](03-satisfaction.md)
again, this time proving out a real veto rather than an abstract duplicate.

### `weighted-voting`

Delaware's default corporate voting rule, one vote per share, modeled by repeating a
holder's key hash once per share they carry. `quorum-floor` and `majority` apply two
different real numbers to the same three-holder cohort: the statutory one-third quorum
minimum, and the default majority-to-pass threshold. A native script cannot express
"present but not voting", so both thresholds are evaluated over the same yes-signers
rather than the statute's own two-step present-then-vote procedure; the two cases still
demonstrate what the brief asks for, a quorum figure and a supermajority-adjacent figure
that are genuinely different numbers over one cohort.

### `treasury-emergency-path`

Explicitly generic, per the project's rule against attributing an invented number to a
real organization: no published treasury's actual board size, emergency cohort size or
delay is claimed here. What the family exercises is a shape none of the timelock cases
elsewhere in the corpus reach: a multi-member board threshold and a smaller multi-member
emergency threshold, gated by a timelock rather than a single signature. `timelocks`
already proves that an absent validity bound fails a timelock; this family proves the
same rule still holds once the thing being gated is a board, not a key.

## Sizing against the chain-exercise ceilings

None of the five families approaches either size ceiling
[06-chain-exercises.md](06-chain-exercises.md) establishes. The largest script here,
`conway-ratification`'s `hard-fork-initiation` and `info` cases at 32 signers across
three cohorts, is 1,039 bytes of CBOR: about six percent of the 16,384-byte inline
ceiling, and nowhere near the point where a reference script becomes the only way to
carry it. `breadth`, `nest-linear` and the largest `federation` cases bracket the size
ceilings; these five test whether nesting, duplication and timelocks evaluate correctly
at the shapes real governance bodies actually take, which is a different question from
how large one can grow.

## Sources

- CIP-1694 (`github.com/cardano-foundation/CIPs`, `CIP-1694/README.md`): the
  constitutional committee's worked expiry example, the ratification table naming which
  bodies vote on which action type, and the statement that ratification is a conjunction
  of the applicable bodies.
- Mainnet's Conway genesis configuration,
  `book.world.dev.cardano.org/environments/mainnet/conway-genesis.json` (mirrored from
  `IntersectMBO/cardano-configurations`): the committee's real size and threshold, and
  the `dRepVotingThresholds` and `poolVotingThresholds` actually in force after the
  Conway (Chang) hard fork.
- The Charter of the United Nations, Articles 23 and 27, read from the United Nations'
  own publication at `un.org/en/about-us/un-charter/chapter-5`. Article 27 was amended in
  1965; the text used here is the one currently in force.
- Delaware General Corporation Law, 8 Del. C. sections 212(a) and 216, read from
  `delcode.delaware.gov/title8/c001/sc07`.

Every threshold drawn from a governance parameter (the committee's own threshold, every
`dRepVotingThresholds` and `poolVotingThresholds` entry) is a value that later governance
action can change. What is recorded here is the value at the Conway genesis, not a claim
that it holds indefinitely, the same qualification
[06-chain-exercises.md](06-chain-exercises.md) makes about `maxTxSize` and every
ceiling derived from it.
