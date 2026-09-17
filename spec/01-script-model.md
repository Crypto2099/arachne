# The script model

A native script is a small expression tree that a transaction either satisfies or does
not. It has no state, reads nothing from the chain, and sees exactly two things about
the transaction that carries it: the set of verification key hashes that witnessed it,
and the transaction's validity interval. That is the whole input.

This makes native scripts completely analyzable offline, which is what Arachne relies
on. Given a script and a witness set, the answer is determined. Nothing else matters.

## The grammar

From the Conway-era ledger CDDL:

```cddl
native_script =
  [  script_pubkey
  // script_all
  // script_any
  // script_n_of_k
  // script_invalid_before
  // script_invalid_hereafter
  ]

script_pubkey = (0, addr_keyhash)

addr_keyhash = hash28

script_all = (1, [* native_script])

script_any = (2, [* native_script])

script_n_of_k = (3, n : int64, [* native_script])

int64 = min_int64 .. max_int64

; Timelock validity intervals are half-open intervals [a, b).
; This field specifies the left (included) endpoint a.
script_invalid_before = (4, slot)

; Timelock validity intervals are half-open intervals [a, b).
; This field specifies the right (excluded) endpoint b.
script_invalid_hereafter = (5, slot)
```

Quoted from `eras/conway/impl/cddl/data/conway.cddl` in `IntersectMBO/cardano-ledger`.

Six node types, three of which carry children. There is no depth limit in the grammar,
no limit on the number of children, and no constraint tying `n` to the length of the
list beside it.

## The JSON form

Tooling exchanges native scripts as JSON, in the shape `cardano-cli` established and
that MeshJS, Blockfrost and most wallets now use. Arachne treats this as the canonical
interchange form.

```json
{ "type": "sig", "keyHash": "<56 hex characters>" }
{ "type": "all", "scripts": [ ... ] }
{ "type": "any", "scripts": [ ... ] }
{ "type": "atLeast", "required": 2, "scripts": [ ... ] }
{ "type": "after", "slot": 1000 }
{ "type": "before", "slot": 9000000 }
```

## The name inversion

The JSON tag names and the CDDL field names are inverted with respect to each other,
and this is the single most reliable source of error in the area.

| JSON tag | CDDL field                 | CBOR tag | Means                                               |
| -------- | -------------------------- | -------- | --------------------------------------------------- |
| `after`  | `script_invalid_before`    | 4        | The transaction is valid only at or after this slot |
| `before` | `script_invalid_hereafter` | 5        | The transaction is valid only before this slot      |

Read the JSON tags as constraints on the transaction ("valid after slot N") and the
CDDL fields as the names of the transaction fields they are compared against. An
implementation that maps JSON `after` to CBOR tag 5 produces a well-formed script with
a valid hash that means the opposite of what its author intended. Nothing downstream
catches it, because there is nothing wrong with the result.

## The envelope

A script frequently arrives wrapped:

```json
{ "type": "timelock", "value": { "type": "all", "scripts": [ ... ] } }
```

The outer `type` names the script language, not a script type. Blockfrost uses
`timelock`; other tools use `simple` or `native`. The envelope is metadata and is not
part of what gets hashed. Strip it before doing anything else. Hashing the envelope
produces a hash that matches nothing on chain.

## Three tiers, not two

A script can fail in three distinct ways, and conflating them is how an
implementation ends up producing something nobody can spend.

| Tier          | Encodes | Hashes | Has an address | A node can decode it | Can ever be satisfied | Can appear on chain        |
| ------------- | ------- | ------ | -------------- | -------------------- | --------------------- | -------------------------- |
| Ordinary      | yes     | yes    | yes            | yes                  | yes                   | yes                        |
| Unsatisfiable | yes     | yes    | yes            | yes                  | **no**                | yes, as a reference script |
| Undecodable   | yes     | yes    | yes            | **no**               | not reachable         | **never**                  |

The third tier is the dangerous one, because nothing about it looks wrong until
the funds are already in. A script with a slot outside `uint` still serializes to
CBOR, still hashes to a real 28-byte value, and still yields an address a wallet
will happily pay. Only a transaction trying to SPEND it fails, and it fails at
deserialization rather than at script validation, so the failure does not even
name the script.

An implementation MUST NOT produce a tier three script.

### What it takes for a script to reach the chain

An address carries only a hash, so funding one reveals nothing about the script. The bytes
themselves reach the chain by exactly two routes, with different requirements.

**In a witness set**, when something is spent. Native scripts are phase one, so a
transaction whose script is not satisfied is rejected outright and never enters a block.
There is no equivalent of a Plutus phase two failure that lands with collateral taken. By
this route a script becomes visible only in a transaction that succeeded, which means it
was both decodable and satisfied.

**In a transaction output, as a reference script.** Nothing executes it, so satisfiability
is irrelevant. This is how an unsatisfiable script reaches the chain: `any []` was stored
this way on preprod in
`cf05ba2db6ca337655f94e3b081a4ca4c6682c6c5e9e5f9f6b8b0d39a2eb1989`, and an indexer now
reports it as `{"type": "any", "scripts": []}` against script hash
`52dc3d43b6d2465e96109ce75ab61abe5e9c1d8a3c9ce6ff8a3af528`. It can never be satisfied and
it is permanently visible. This transaction is indexed in
[chain-evidence/observations.json](../chain-evidence/observations.json), alongside every
other transaction hash named in this specification.

The node does validate what it stores. `script_ref = #6.24(bytes .cbor script)` wraps the
script in a BYTE STRING, so the surrounding transaction stays well-formed whatever is
inside, and the decoder has to look deliberately to notice. It looks. A reference script
carrying `after(-1)` was refused, and so was one carrying bytes that are not CBOR at all,
both with `DecoderErrorDeserialiseFailure` rather than a script error.

So the line that matters is decodability, not executability. A script that cannot be
decoded cannot reach the chain by either route, which is what makes building one worse
than building a merely useless one: the address is real and fundable, and the script
behind it can never be published, executed, or shown to anyone.

Concretely, an encoder MUST refuse a `slot` that is not an integer in `0` to
`2^64-1`. `slot` is `uint`, so a negative value is CBOR major type 1 where the
grammar requires major type 0, and a value past `2^64-1` needs a bignum, which is
also not a `uint`. Both were submitted to preprod and both were refused with
`DecoderErrorDeserialiseFailure`, at any magnitude: `after(-1)` and
`after(-(2^64-1))` fail identically, because the problem is the type rather than
the size.

A decoder MUST NOT narrow a slot it cannot represent. This implementation stores
`slot` as a JavaScript number and is exact only to `2^53-1`, so it refuses a
larger one rather than rounding: slot `2^60+1` narrowed to `2^60` re-encodes to
different bytes and yields a different script hash, and therefore a different
address, with nothing raised. `scriptHashFromCbor` hashes such a script correctly
without decoding it, which is the right primitive whenever bytes arrive from
somewhere else.

Tier two is different and must stay permitted. An `any []` can never be
satisfied, but it is a legal script the ledger accepts and evaluates, and
refusing to parse one means being unable to read scripts that exist on chain.
The distinction is between a script that says something impossible, which is
allowed, and a byte string that is not a script at all, which is not.

## Shapes that are well-formed and useless

The grammar admits several scripts that no tool intends to produce and that no
validation rejects. They have real hashes and real addresses.

| Shape                                           | Behavior                                               |
| ----------------------------------------------- | ------------------------------------------------------ |
| `all` with no children                          | Vacuously satisfied, by any witness set including none |
| `any` with no children                          | Can never be satisfied                                 |
| `atLeast` with `required` 0                     | Satisfied with no witnesses at all                     |
| `atLeast` with `required` above the child count | Can never be satisfied                                 |
| `atLeast` with a negative `required`            | `n` is `int64`, so this encodes. Satisfied trivially   |
| The same key hash twice under one threshold     | One signature counts toward the threshold twice        |

These are not validation errors and Arachne does not treat them as such. A parser that
rejects them cannot read scripts that exist. The corpus carries each one, and each
vector records the oddity as a remark so that its presence reads as deliberate.

The CDDL types `n` as `int64` rather than
`uint`, with `min_int64 = -9223372036854775808`, and carries the comment "Allegra
switched to int64 for script_n_of_k thresholds". A negative value is therefore
representable on the wire, and it is not exotic. cardano-cli builds one straight from an
ordinary JSON script file and prints its hash without complaint, so any tool driving the
CLI can produce one by accident. cardano-serialization-lib is the outlier here rather
than the rule: its constructor takes an unsigned count, so a negative threshold reaches
it only as a wrapped unsigned value, which is a separate defect recorded in the
compatibility results.

The validation is one-sided. cardano-cli accepts every value at or below zero, and
refuses a threshold above the child count with "Required number of script signatures
exceeds the number of scripts."

### A negative threshold and a negative slot are not the same case

The two sit adjacent in the grammar and have different types, so it is easy to conclude
from one that a tool is wrong about the other.

| Field                                               | CDDL                  | Negative                                       |
| --------------------------------------------------- | --------------------- | ---------------------------------------------- |
| `script_n_of_k` threshold                           | `n : int64`           | In the grammar, down to `-9223372036854775808` |
| `script_invalid_before`, `script_invalid_hereafter` | `slot = uint .size 8` | Not in the grammar at all                      |

A tool accepting a negative threshold is following the specification. A tool accepting a
negative slot would not be, and would be producing a script that hashes to a real address
no transaction can ever spend, because the node's decoder refuses the transaction rather
than the script.

cardano-cli 10.7.0.0 gets both right. It builds a script with `"required": -1` and prints
its hash, and refuses `"slot": -1` with a syntax error, in both the `after` and `before`
positions and at any magnitude.

## Depth and breadth

Nesting depth and child count are where "what is possible" stops being a question about
the grammar and starts being a question about a running ledger.

**No recursion limit is specified anywhere.** The grammar is directly recursive through
`script_all = (1, [* native_script])` and imposes no depth bound, no child-count bound,
and no total-node bound. The ledger's evaluator is ordinary recursion with no depth
counter. The CBOR decoder carries no nesting limit either. Searching the Conway CDDL
for any mention of depth, recursion or nesting returns nothing at all.

What constrains a script is therefore the transaction size limit, and it binds on total
bytes rather than on structure. This is why depth and breadth trade against each other
rather than each having a ceiling of its own.

A flat `all` of 400 signatures encodes to 12,805 bytes against a `maxTxSize` of 16,384.
That figure is a protocol parameter rather than a property of native scripts, so every
ceiling derived from it moves if governance moves it, and
[06-chain-exercises.md](06-chain-exercises.md) sets out which limits follow from it. At
its current value, 12,805 bytes leave too little room for the inputs, outputs and
witnesses that have to travel with it. Nesting is far cheaper per level: each container costs a handful of bytes, so
a deeply nested script stays small long after a wide one has stopped fitting.

The residual risk is not a specified limit but an unspecified one. A structure with no
declared bound is bounded in practice by whatever each implementation does when it
recurses, and a stack limit in a wallet, an indexer or a serialization library is not
written down anywhere and will differ between them. A script that the ledger accepts
can still be one that a wallet cannot display or a backend cannot parse. That is
precisely the class of limit that only submission and round-tripping can find, and it
is what the depth families in the corpus are built to locate.
