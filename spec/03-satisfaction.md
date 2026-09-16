# Satisfaction

Whether a witness set satisfies a script. This is the question Ekklesia's
authentication gate asks on every request, and the one where an implementation can be
wrong for years without noticing, because the wrong answer is usually the conservative
one and looks like a user error.

## The inputs

A script is evaluated against exactly two things:

- `signers`, the set of verification key hashes with a vkey witness on the transaction.
- The transaction's validity interval, as two independently optional bounds:
  `validityStart`, which is transaction body field 8, the validity interval start, and
  `validityEnd`, which is field 3, the time to live.

  These are fields of the transaction, not of the script. The script's own
  `script_invalid_before` and `script_invalid_hereafter` are what get compared against
  them, and the two sets of names are easy to run together.

Both bounds are optional because both are optional in a transaction body. Their absence
is not neutral, which is rule three below.

## The rules

```
satisfies(sig(k))         =  k in signers
satisfies(after(n))       =  validityStart is present and n <= validityStart
satisfies(before(n))      =  validityEnd is present and validityEnd <= n
satisfies(all(xs))        =  every x in xs satisfies
satisfies(any(xs))        =  some x in xs satisfies
satisfies(atLeast(k, xs)) =  k <= count of x in xs that satisfy
```

Over an empty list, `all` is satisfied and `any` is not, which follows from the
quantifiers rather than being a special case. `atLeast` over an empty list is satisfied
when `k` is zero or below, for the same reason.

These are not this project's reading. They are the ledger's `evalTimelock`, transcribed:

```haskell
lteNegInfty _ SNothing = False          -- an absent validity start fails
lteNegInfty i (SJust j) = i <= j
ltePosInfty SNothing _ = False          -- an absent validity end fails
ltePosInfty (SJust i) j = i <= j

isValidMOf n SSeq.Empty = n <= 0
isValidMOf n (ts SSeq.:<| tss) =
  n <= 0 || if go ts then isValidMOf (n - 1) tss else isValidMOf n tss

go = \case
  RequireTimeStart lockStart -> lockStart `lteNegInfty` txStart
  RequireTimeExpire lockExp  -> txExp `ltePosInfty` lockExp
  RequireSignature hash      -> hash `Set.member` vhks
  RequireAllOf xs            -> all go xs
  RequireAnyOf xs            -> any go xs
  RequireMOf m xs            -> isValidMOf m xs
```

Source: `eras/allegra/impl/src/Cardano/Ledger/Allegra/Scripts.hs` in
`IntersectMBO/cardano-ledger`. Every rule below is read from it rather than inferred
from behavior.

## The three that implementations get wrong

These are not exotic. Each one has shipped.

### A threshold counts satisfied sub-scripts, not distinct keys

`isValidMOf` walks the child list and decrements the counter each time a child
evaluates true. It does not deduplicate, and it has no access to the identity of what
satisfied a child. Two children naming the same key are two children.

So `atLeast(2, [sig(A), sig(A)])` is satisfied by A alone. One signature, two satisfied
children, threshold of two.

An implementation that walks the tree collecting key hashes into a set, then compares
the set against the threshold, sees one key against a threshold of two and returns
false. The set is where the information is lost.

### Nesting does not flatten

`go` recurses, and each container returns a single boolean to its parent. A nested
threshold is one vote in its parent, whatever it contains.

`all[ any[A, B], sig(C) ]` requires C and either A or B. An implementation that
accumulates key hashes up the tree and sets the requirement to the total count at the
root turns that into a demand for A, B and C together. Every legitimate two-signature
attempt is then refused, and the refusal looks exactly like a missing signature.

This is the shape that arrives once an organization's board has a seat that is itself a
multisig, which is the normal way these structures grow.

### A timelock against an absent interval bound fails

`lteNegInfty _ SNothing = False` is the whole rule, and the comment beside it in the
ledger reads `i > -∞`. An absent validity start is negative infinity, and no slot is at
or before it, so the condition is unmet. `ltePosInfty SNothing _ = False` is the mirror
image for the upper bound.

So `after(n)` is not satisfied by an unbounded transaction. It is not skipped, and it
is not neutral.

The consequence is that a script combining a signature with a timelock, which is an
extremely common shape, cannot be satisfied by a transaction that sets no validity
interval, however many correct signatures it carries. An evaluator that considers only
signatures and treats timelocks as someone else's problem will report such a script
satisfied and then watch the node reject the transaction.

The mainnet DRep used as a worked example throughout this specification has exactly
this shape: `all[ sig(40f07f...), after(1) ]`. Slot 1 is in the past and the timelock
is decorative, but it still has to be bounded to be met.

## Half-open intervals

The CDDL states that timelock validity intervals are half-open, `[a, b)`.
`script_invalid_before` is the included left endpoint and `script_invalid_hereafter`
the excluded right endpoint. The comparisons above follow from that and are stated in
terms of the transaction's own bounds, so an implementation does not need to reason
about the interval algebra separately. It needs `n <= validityStart` and
`validityEnd <= n`, with an absent bound failing.

## Extreme and invalid time bounds

Slots are `uint` in the CDDL, so the interesting cases sit at the two ends of that range
and just outside it. All four were submitted to preprod, and the results separate two
failure modes that are easy to conflate.

| Script                                         | Result on preprod                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `all [ sig(k), before(18446744073709551615) ]` | Accepted, `aecef57696d8ea556442a8f305b5768e3ad9fb219561d02516eddbdbeca656e2` |
| `all [ sig(k), before(0) ]`                    | Refused, `OutsideValidityIntervalUTxO`                                       |
| `all [ sig(k), after(18446744073709551615) ]`  | Refused, `OutsideValidityIntervalUTxO`                                       |
| `all [ sig(k), before(-1) ]`                   | Refused, `DecoderErrorDeserialiseFailure`                                    |

A `before` at the largest representable slot constrains nothing. 2^64-1 slots is roughly
585 billion years, and any transaction's `invalid_hereafter` is below it, so the timelock
is satisfied by construction. It still has to be SET, because an absent bound fails, so
the script is not quite a no-op: it forces the transaction to declare a ttl and then
accepts any value.

The two impossible bounds fail somewhere different from an ordinary unsatisfied script.
`before(0)` needs `ttl <= 0`, and `after(2^64-1)` needs a validity start 585 billion years
away. In both cases the transaction is refused for being outside its own validity
interval, against the current slot, before the script is evaluated at all:

```
OutsideValidityIntervalUTxO
  (ValidityInterval {invalidBefore = SNothing, invalidHereafter = SJust (SlotNo 0)})
  (SlotNo 133854816)
```

That is the ledger rejecting the transaction, not the witness. An implementation that
reports these as "script not satisfied" is describing a failure the node never reached.

A negative slot is rejected earlier still. `slot` is `uint`, so a negative value is not in
the grammar, and encoding one as CBOR major type 1 makes the whole transaction
undecodable rather than merely invalid. The bound is enforced by the decoder, not by
script validation, so such a script can be constructed and hashed and will yield a real
address, but nothing spending it can ever be parsed.

## Degenerate thresholds

`isValidMOf n` short-circuits on `n <= 0` at every step, including the first. This
settles three cases that look like they need special handling and do not:

| Case                             | Result                       | Why                                                           |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `required` is 0                  | Satisfied, with no witnesses | `n <= 0` on entry                                             |
| `required` is negative           | Satisfied, with no witnesses | Same. The CDDL types `n` as `int64`, so this is representable |
| `required` above the child count | Never satisfied              | The list runs out with `n` still above 0                      |

The negative case is not exotic. The CDDL carries the note "Allegra switched to int64 for
script_n_of_k thresholds", and cardano-cli builds one from an ordinary JSON script file
without complaint, so it is reachable through the standard tooling path rather than only
through a deliberate encoder. cardano-serialization-lib is the one that cannot express
it, because its constructor takes an unsigned count.

## Evaluation status

| Rule                                                | Status                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| Signature membership                                | Confirmed against the ledger source and cardano-serialization-lib |
| Threshold counts sub-scripts, not keys              | Confirmed against the ledger source                               |
| Nesting does not flatten                            | Confirmed against the ledger source                               |
| An absent interval bound fails a timelock           | Confirmed against the ledger source                               |
| Empty `all` is satisfied, empty `any` is not        | Confirmed against the ledger source                               |
| `required` at or below zero is satisfied            | Confirmed against the ledger source                               |
| An absent interval bound fails a timelock, on chain | Confirmed on preprod                                              |
| Empty `all` satisfied and empty `any` not, on chain | Confirmed on preprod                                              |
| A node accepts a transaction carrying the others    | Not yet observed                                                  |

Three of those rows have since been confirmed against a real node on preprod rather than
only against the ledger source.

The timelock rule was tested with two transactions identical apart from their validity
interval, spending `all [ sig(k), after(133000000) ]`. Without an interval the node
refused with
`ConwayUtxowFailure (ScriptWitnessNotValidatingUTXOW ... ScriptHash "036b3fb6...")`.
With `validityStart` set to the locked slot the same signature was accepted, as
transaction `6ce721421b4b0994b7cf268cb0be84165dbaf0c2da1f8a112b36afb808f05346`. A correct
signature is not sufficient, which is the whole point of the rule.

The empty containers were tested as themselves. An `all []` address was spent with NO
vkey witness at all, accepted as
`74aa539069a5b4c84a63649c9cf18bc71c0bd813ff1cb28b7226d431ff00a83c`: anyone holding the
script can spend such an address. An `any []` address refused every attempt and its funds
are locked permanently, which is recorded in the corpus rather than described.

The remaining row stays open. Source agreement establishes what the ledger computes, not
that a transaction carrying an unusual script survives everything else between a wallet
and a block.

## When a node disagrees

The node is right. See [05-conformance.md](05-conformance.md) for how a contradiction
is recorded and what has to happen next. The one response that is never acceptable is
editing the observation to match the expectation.
