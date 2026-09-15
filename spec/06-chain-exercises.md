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

Two consequences follow, and they pull in opposite directions.

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
a DRep, because the transaction carrying it is shaped differently and the witness
reaches the ledger by another route.

| Role                | Steps                                                       | The step that actually tests the script                               |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Payment, enterprise | Fund the script address, spend it back                      | The spend                                                             |
| Payment and stake   | Fund the base address, register the stake credential, spend | The spend, with the same hash in both credential slots                |
| Stake               | Register, delegate, withdraw rewards                        | The withdrawal                                                        |
| DRep                | Register with the 500 ADA deposit, vote, retire             | The vote                                                              |
| CC cold             | Authorize a hot credential                                  | The authorization, and only where a testnet has seated the credential |
| CC hot              | Cast a committee vote                                       | The vote, with the same constraint                                    |

Registration alone proves that the credential is accepted, not that the script can
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

## Many scripts in one transaction

A single script is bounded by `maxTxSize` whichever route it takes, so the interesting
use of the 200 KiB reference budget is not one larger script but many scripts
interacting in one transaction. That is the shape a federation produces: several
organizations, each governed by its own sizeable multisig, transacting together.

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
