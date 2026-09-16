# Chain exercises

The only question that submission answers, and the only way to answer it.

Everything in [02-encoding.md](02-encoding.md) and [03-satisfaction.md](03-satisfaction.md)
is settled offline and completely. What is not settled offline is whether a real node
accepts a transaction carrying a given script. That is a property of a running ledger
and of every implementation between a wallet and a block, and no amount of reading
establishes it.

Arachne exercises against preview and preprod. Both carry mainnet's protocol
parameters, and the two share network tag 0, so a script has one address valid on both.

## What the limits actually are

Nothing in the grammar bounds a native script. `script_all = (1, [* native_script])` is
unbounded recursion, the ledger's evaluator is plain recursion with no depth counter,
and the CDDL mentions depth, recursion and nesting nowhere at all. Every real limit
comes from somewhere else, and there are two different ceilings depending on how the
script reaches the ledger.

### Inline in the witness set

The script travels in the transaction's own witness set, so it competes for the
`maxTxSize` budget with everything else in the transaction. That parameter is 16,384
bytes on mainnet, preview and preprod alike.

### As a reference script

Babbage added reference scripts, and they work for native scripts as well as Plutus
ones. The CDDL is `script_ref = #6.24(bytes .cbor script)`, where `script` is the
tagged union whose variant 0 is `native_script`. The script sits in a prior
transaction's output and the spending transaction names that output as a reference
input (transaction body field 18) instead of carrying the script itself.

Conway bounds this separately, with values fixed in the era rather than settable by a
protocol parameter update:

| Bound                      | Value                   |
| -------------------------- | ----------------------- |
| `maxRefScriptSizePerTx`    | 204,800 bytes (200 KiB) |
| `maxRefScriptSizePerBlock` | 1,048,576 bytes (1 MiB) |
| Reference script fee base  | 15 lovelace per byte    |
| Fee tier stride            | 25,600 bytes            |
| Fee tier multiplier        | 1.2                     |

Source: `ppMaxRefScriptSizePerTxG` and its neighbors in
`eras/conway/impl/src/Cardano/Ledger/Conway/PParams.hs`, with the size check itself in
`Conway/Rules/Ledger.hs`.

The per-transaction reference budget is 12.5 times `maxTxSize`, so a spending
transaction can reach far more script than it could ever carry inline. But a reference
script has to be created before it can be referenced, and the transaction that creates
it carries the full script bytes in one of its outputs, where it is bounded by
`maxTxSize` like anything else. A single native script therefore cannot exceed the
inline ceiling by this route. What the 200 KiB budget buys is many scripts in one
transaction, not one larger script.

The ledger's check uses `txNonDistinctRefScriptsSize`, which is non-distinct on
purpose: referencing the same script twice counts its size twice toward the budget.

## The minimal envelope

To find the largest script that fits inline, the transaction around it has to be as
small as a valid transaction can be. The floor is one input, no outputs at all, and the
entire input balance declared as the fee.

`transaction_body` requires only fields 0, 1 and 2, and field 1 is `[* transaction_output]`,
which admits the empty list. Value is preserved because the sum of inputs equals the
fee exactly, and the fee clears the minimum because it is the whole balance. So:

```
body:
  0 : one transaction_input
  1 : []                      no outputs
  2 : the input's entire lovelace, as fee
  3 : ttl                     only if the script has a "before"
  8 : validity start          only if the script has an "after"
witness set:
  native scripts : [ the script under test ]
  vkey witnesses : the minimum the script needs
```

The fee may be any amount at or
above the minimum, so an input holding any sufficient balance works: set the fee to
that balance and the transaction balances by construction.

This envelope is what the size-boundary exercises use. It measures the script against
`maxTxSize` with as little else in the way as possible, which is the closest a
transaction can get to the limit without going over.

## What each credential role proves

"Exercised on-chain" means something different per role, and the differences are not
cosmetic. A script that spends happily as a payment credential may still be refused as
a DRep, because the transaction carrying it is shaped differently, and the witness
reaches the ledger by another route.

| Role                | Steps                                                       | The step that actually tests the script                               |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Payment, enterprise | Fund the script address, spend it back                      | The spend                                                             |
| Payment and stake   | Fund the base address, register the stake credential, spend | The spend, with the same hash in both credential slots                |
| Stake               | Register, delegate, withdraw rewards                        | The delegation, and every later operation on the credential           |
| DRep                | Register with the 500 ADA deposit, vote, retire             | The vote                                                              |
| CC cold             | Authorize a hot credential                                  | The authorization, and only where a testnet has seated the credential |
| CC hot              | Cast a committee vote                                       | The vote, with the same constraint                                    |

### Confirmed on preprod

Two credential roles have now been exercised end to end, each with a different script
shape so that neither result depends on the other's structure.

A 3-of-5 board registered as a DRep, voted, updated itself and retired, script hash
`ce021f147f597c5b48affb3d51de3be142ffd9fd898e8631b4948964`:

| Step                            | Transaction                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| Register, 500 ADA deposit       | `31ec4648ea0ce886d0ca0abda3ea839be56dfc2acf1070a57f981f66e2f5d286` |
| Vote yes on a governance action | `ae52f76f442fbe6ad53bda43d83d1e8a402ea6132c9a8d4ef825f85c7f9df46d` |
| Update                          | `3770ba2b45cbcdc3217793d30ac845f23f6e7b7714bf1a59b365745fe0207270` |
| Retire, deposit reclaimed       | `f5822f80d4236138a9b913dac29c3545b0cd380b23144b7e878875ebef550854` |

The vote is the step this table calls the real test, and it is readable back from an
indexer rather than only from the submission: querying `drep_votes` for that credential's
CIP-129 identifier returns the vote as `Yes` against the action it was cast on. Three of
the five board signatures satisfied the script each time.

A 2-of-3 trustee credential registered as a stake credential, delegated and retired,
script hash `3a2640ad93281967ce64763495bf27064ddce92de689a067072a3b4e`:

| Step                      | Transaction                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| Register, 2 ADA deposit   | `436d377b754b503d4319c65ead5ee17495c27688bee910fdcf6c3614e381065e` |
| Delegate to a stake pool  | `4e068e25cbdbe45f602d953bdb4a96e011cc961d4ca46ad4d6f7d81478ff6d44` |
| Retire, deposit reclaimed | `3740d5d65f046d17197ce57bf6172e41d46c2a072b014549a7e8f31bff5227d2` |

The withdrawal is NOT among these, so the row above still stands unconfirmed for stake. A
withdrawal needs rewards, rewards need a full epoch of active delegation, and this
credential was retired before one elapsed. Registration and delegation both succeeded,
which is exactly what that row warns is insufficient.

### The delegation already tests the script

An earlier version of this document said the withdrawal was the operation that really
tested a stake script, on the reasoning that registration and delegation might both
succeed for a credential that could not later authorize anything. That is wrong for
delegation, and it was checked rather than reasoned about.

Delegating a script stake credential was submitted three ways against the same 2-of-3
script:

| Witness set                            | Result                                                      |
| -------------------------------------- | ----------------------------------------------------------- |
| No script, no trustee signatures       | `MissingScriptWitnessesUTXOW`, naming the credential's hash |
| Script present, one trustee signature  | `ScriptWitnessNotValidatingUTXOW`                           |
| Script present, two trustee signatures | Accepted                                                    |

So the script is required for a delegation and its threshold is evaluated there, in full.
A withdrawal exercises the same credential witness path and would demonstrate nothing
further about native script behavior, which is why this document no longer treats it as
the operation that matters for this role.

The middle row is the more useful of the two refusals. A missing script is an easy
mistake to catch; a script that is present and unsatisfied is the case an implementation
gets wrong quietly, and the ledger distinguishes them by name.

Registration is the operation that proves least. It proves that the credential is
accepted, not that the script can
authorize anything. The distinction matters most for stake and DRep credentials, where
registration and delegation can both succeed for a script that cannot later authorize a
withdrawal or a vote.

## What an exercise must produce

An observation is evidence, and it is recorded in the vector's `onchain` array:

```json
{
  "network": "preview",
  "role": "drep",
  "action": "vote",
  "caseId": "0+1@unbounded",
  "accepted": false,
  "error": "<the node's verbatim message>",
  "observedAt": "2026-09-15T21:09:16.032Z"
}
```

An accepted submission carries a `txHash`, so anyone can look it up. A rejected one
carries the node's message unmodified. A provider that normalizes or prettifies errors
destroys the evidence, which is why the provider interface passes the response body
through untouched.

A rejection is a result, not a failure of the exercise. It is how a limit is found:
something is refused and the refusal says why.

## Never fabricate an observation

The corpus resolves a disagreement between the reference evaluator and a node in the
node's favor. That rule is only safe while every observation came from a node.

An observation that was never submitted is worse than no observation, because it
carries the same authority and will be used to overrule correct code. This is why
`runExercise` throws rather than returning a plausible result while transaction
construction is unimplemented, and why a rebuild carries `onchain` forward untouched
instead of regenerating it.

## Cost

Exercises spend testnet ADA. The DRep deposit is 500 ADA per registration, refunded on
retirement, which makes DRep exercises the expensive ones and makes retirement part of
the exercise rather than cleanup. Preview and preprod faucets are rate limited, so a
full sweep is planned rather than run on every change. The chain suite is a separate
vitest project for this reason and is never part of the default test run.

## Every ceiling here is a protocol parameter away from changing

`maxTxSize` is a protocol parameter. Governance can raise or lower it, and every size
result in this document is a consequence of its current value, 16,384 bytes. None of the
numbers below are properties of native scripts. They are properties of native scripts at
one parameter setting.

**Do not hard-code them.** `src/chain/ceilings.ts` exposes `maxLinearNestDepth`,
`maxUnanimousInline` and `maxUnanimousByReference` as functions of `maxTxSize`, and a
test pins each to the value a real node actually accepted and refused at 16,384. Read the
parameter from the chain and pass it in. `ChainProvider.protocolParams` returns it.
`minFeeRefScriptCostPerByte` is a protocol parameter too, and the constant in
`src/chain/bundle.ts` is named a fallback for that reason rather than a default to rely
on.

**Every observation records the parameters it was made under.** A result saying a
123-member multisig was refused for size is not interpretable without the limit it was
refused against, and a timestamp does not supply one: a reader cannot recover a past
parameter set from a date. Each entry in a vector's `onchain` array therefore carries
`protocolParams`, so a result read under a different configuration is still true and is
legibly true of a different chain.

The reference script budget is a different case. Conway fixes 204,800 bytes per
transaction in the era rather than exposing it as an updatable parameter, so it cannot be
read from a node's parameter set. That makes it constant for as long as Conway is the
era, and something to recheck against a later era's own definitions rather than to trust.

Everything below was measured on preprod in epoch 313, at `maxTxSize` 16,384, `minFeeA`
44, `minFeeB` 155,381 and `minFeeRefScriptCostPerByte` 15.

## How deep a single script can nest

Nesting is far cheaper than breadth. One `all` wrapper is three bytes, `82 01 81`, against
the 32 a signature entry costs and the 101 its witness costs, so depth is the axis on
which a script grows most slowly.

A single key wrapped in `all` repeatedly was submitted at the deepest point that fits.

| Depth | Script       | Spending transaction | Result                                                                       |
| ----- | ------------ | -------------------- | ---------------------------------------------------------------------------- |
| 5,383 | 16,181 bytes | 16,383 bytes         | Accepted, `f90dce5765108da976abdbb9fc618f9a6ffd9fa4d93b2f288eed1808545424c9` |
| 5,384 | 16,184 bytes | 16,386 bytes         | Refused, `MaxTxSizeUTxO` supplied 16385 expected 16384                       |

**A single key can be nested 5,383 levels deep and still spent**, in one transaction, with
one signature. One level further is refused, and refused for size: the node reports
`MaxTxSizeUTxO` and says nothing about the script.

That settles the open question in this specification. No recursion limit is written down
in the CDDL, in the ledger's evaluator, or in its decoder, and none exists in practice
either. A node accepted the deepest nest a transaction can physically carry, so size is
not merely the first limit reached, it is the only one.

The naive arithmetic for this ceiling is `(16384 - 32) / 3 = 5450`, which is wrong because
it counts only the script. A real spending transaction also carries its input, its output,
its fee and one vkey witness, about 202 bytes together, which brings the ceiling to 5,383.

## How large a single multisig can be

The script is rarely the constraint. The signatures are.

A `sig` entry inside a script costs 32 bytes. The vkey witness that satisfies it costs
101: an array header, a 32-byte verification key with its header, and a 64-byte signature
with its header. Every _required_ signer therefore costs about 133 bytes of the
transaction, and every merely eligible one costs 32.

Computed against a 16,384-byte `maxTxSize`, with one input and one output returning the
funds, and the script carried inline:

| Threshold rule                | Largest n | Signatures needed | Script bytes | Transaction bytes |
| ----------------------------- | --------- | ----------------- | ------------ | ----------------- |
| n-of-n, unanimous             | 122       | 122               | 3,910        | 16,325            |
| Three quarters                | 150       | 113               | 4,806        | 16,312            |
| Two thirds                    | 163       | 109               | 5,222        | 16,324            |
| Simple majority, floor(n/2)+1 | 196       | 99                | 6,278        | 16,370            |
| 1-of-n                        | 505       | 1                 | 16,165       | 16,358            |

At the unanimous ceiling the script is 3,910 bytes, under a quarter of the limit. The
signatures are 12,322 and the remaining 93 are the transaction envelope. Lowering the
threshold buys members quickly, and a 1-of-n reaches 505 because the script is then free
to fill the transaction on its own.

Dropping the output to the minimal envelope frees 37 bytes, which matters only where a
member costs 32 rather than 133. The unanimous, three-quarters and two-thirds rows are
unchanged, simple majority moves from 196 to 197, and 1-of-n from 505 to 506.

### Moving the script out of the transaction

A reference script lifts the ceiling, because the script bytes move into a prior output
and the spending transaction carries a reference input instead.

| Unanimous n | Inline                  | As a reference script   |
| ----------- | ----------------------- | ----------------------- |
| 122         | 16,325 bytes, fits      | 12,451 bytes, fits      |
| 140         | 18,719 bytes, too large | 14,269 bytes, fits      |
| 160         | 21,379 bytes, too large | 16,289 bytes, fits      |
| 161         | 23,512 bytes, too large | 16,390 bytes, too large |

By this arithmetic a unanimous multisig reaches 122 members inline and 160 as a reference
script. The script at 160 members is 5,126 bytes, inside both `maxTxSize` for the
transaction that creates it and the 204,800-byte per-transaction reference budget.

### Where it stops

161 required signatures are 16,261 bytes of witness before a single byte of script,
input, output or fee. No encoding choice, reference script or envelope trimming reaches
past that, because the signatures travel with the transaction that spends.

**By this arithmetic, a unanimous native multisig cannot exceed 160 members** at the
current `maxTxSize`, and cannot exceed 122 with the script carried inline.

### Confirmed on preprod

All four boundary transactions were submitted. Every cosigner is a real ed25519 key and
every signature is real, derived deterministically as blake2b-256 of
`arachne/multisig/<i>` so the cohort reproduces from nothing but its index.

| Transaction                     | Size   | Result                                                                       |
| ------------------------------- | ------ | ---------------------------------------------------------------------------- |
| 122-of-122, script inline       | 16,334 | Accepted, `1d40d02c1b63a5eac942ff18c9731b457b502ca732820279a87c1a6f3f2bb140` |
| 123-of-123, script inline       | 16,467 | Refused, `MaxTxSizeUTxO` supplied 16466 expected 16384                       |
| 160-of-160, script by reference | 16,298 | Accepted, `ebccf64ce29571dde8bfaf2e7f741582254a937cf862082188ffa697d00cffd3` |
| 161-of-161, script by reference | 16,399 | Refused, `MaxTxSizeUTxO` supplied 16398 expected 16384                       |

**A unanimous native multisig tops out at 122 members with the script carried inline, and
160 with it delivered by reference input.** Both ceilings are exact: one more member is
refused in each case, and refused for size rather than for anything about the script.

Two details the arithmetic in this section did not predict.

The envelope is 9 bytes larger than assumed. Conway sets carry CBOR tag 258, and the
inputs, vkey witnesses and native scripts lists each pay 2 bytes for it. The tables above
are therefore about 9 bytes optimistic, which moves no ceiling: 122 fits at 16,334 rather
than 16,325, and 123 misses by 83 bytes either way.

A transaction spending through a reference script pays a tiered surcharge on top of the
size fee, and omitting it gets the transaction refused for `FeeTooSmallUTxO` rather than
accepted. The node's own expectation confirmed this project's implementation of
`tierRefScriptFee` exactly: for a 5,126-byte reference script the surcharge is 76,890
lovelace, and `base(16297) + 76890` equals the fee the node demanded to the lovelace.

That arithmetic also exposed a one-byte disagreement. The node measured the transaction
at 16,297 bytes where this builder measured 16,298, the same offset seen in the 123-of-123
refusal, which reported 16,466 against a build of 16,467. The direction is consistent,
and it has no effect on any ceiling here, but it means a transaction built to land exactly on
`maxTxSize` should not be trusted to fit on this measurement alone.

## Federations, and which constraint actually binds

A realistic governance structure is not a flat cohort. It is `all` over member
organizations, each of which is itself a threshold, so every member must contribute
without any of them surrendering its internal rule. That shape has two costs, and which
one binds flips depending on the internal threshold.

A member costs 32 bytes in the script whether or not it signs. A signature costs 101
bytes in the transaction. So a low internal threshold makes members cheap to add but
makes the script large, and a high one makes the script small relative to the witnesses
it demands.

Largest federation of 23-member organizations that can be both created and spent:

| Internal rule | Groups inline | Members | Groups by reference | Members | What stops it                |
| ------------- | ------------- | ------- | ------------------- | ------- | ---------------------------- |
| 1-of-23       | 19            | 437     | 21                  | 483     | Script too large to publish  |
| 3-of-23       | 15            | 345     | 21                  | 483     | Script too large to publish  |
| 12-of-23      | 8             | 184     | 13                  | 299     | Witnesses exceed `maxTxSize` |
| 23-of-23      | 5             | 115     | 6                   | 138     | Witnesses exceed `maxTxSize` |

The reference route stops helping once the threshold is high, because moving the script
out of the spending transaction does nothing about the signatures that have to stay in
it. Below that, the ceiling is the transaction that PUBLISHES the reference script, which
carries the whole script in an output and is bounded like any other transaction.

### Confirmed on preprod

Two of these were submitted.

Eight organizations of 23, each requiring an internal majority of 12. 184 members, 96
signatures, a 5,923-byte script in a 15,721-byte transaction. Accepted as
`26ea4c57248974265629c5513c66a4011cc596286f7128a2bc3b57b71aa4caca`.

Twenty-four organizations of 20, each satisfied by any one member. 480 members, 24
signatures. The script is 15,460 bytes, published as a reference script in a 15,745-byte
transaction, and the spend that used it is 2,562 bytes and cost half an ada. Accepted as
`28afe751287e7f5ee7df73545027960ea0cb1687d07a64937550f0fdac1c0b83`.

The second one carries mixed framing, which nothing else in this corpus does at scale.
Its root list holds 24 entries, so `cardano-binary` frames it indefinitely, while all
twenty-four group lists hold 20 and are framed definite. Exactly one list of twenty-five
diverges. A node accepted it, so the framing rule really is applied per list rather than
per script, and a consumer that decides a script's framing by looking only at its root
will be wrong about scripts like this one.

Twenty-four organizations of 23 would be the more natural shape and cannot exist: its
script is 17,764 bytes and no transaction can publish it. Twenty is the largest group
size at which a 24-organization federation is constructible at all.

## Many scripts in one transaction

A single script is bounded by `maxTxSize` whichever route it takes, so the interesting
use of the 200 KiB reference budget is not one larger script but many scripts
interacting in one transaction. That is the shape a federation produces: several
organizations, each governed by its own sizable multisig, transacting together.

The `federation` and `federation-of-federations` families generate those scripts. The
largest, twenty member organizations of twenty cosigners each, is 12,884 bytes and 400
signatures at depth 3, which nearly fills a transaction on its own. Five of them
together are 64,420 bytes: far past the inline ceiling, comfortably inside the
reference budget.

`bundleBudget` answers the question for a given set:

| Route                     | Bound                                                             | What it costs                       |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Inline in the witness set | `maxTxSize`, 16,384 bytes total                                   | Ordinary transaction fee            |
| Reference scripts         | 204,800 bytes total, each script still created within `maxTxSize` | Tiered reference script fee, on top |

The reference script fee grows geometrically in linear increments: the first 25,600
bytes at 15 lovelace each, the next 25,600 at 18, then 21.6, and so on by a factor of
1.2 per tier. The floor is applied once over the accumulated total rather than per
tier, so it is computed in exact rational arithmetic. Filling the entire 204,800-byte
budget costs 6,335,648 lovelace, about 6.34 ADA, before the ordinary fee.

The tier boundary is strict. The ledger's guard is `n < sizeIncrement`, so a size of
exactly one stride has already advanced to the next tier.

None of the following can be settled offline:

- Whether a transaction spending from several large script addresses at once is
  accepted at each step up in total script size.
- Whether the same script referenced twice is charged and counted twice, as
  `txNonDistinctRefScriptsSize` says it should be.
- Whether a wallet, an indexer or a serialization library gives out before the ledger
  does. The ledger's limits are written down. The limits in everything between a signer
  and a block are not, and a federation transaction is where they get found.
