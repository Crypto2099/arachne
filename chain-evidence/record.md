# Chain evidence, by what each submission establishes

This is the complete record of every real transaction submitted to preprod and indexed in [`chain-evidence/observations.json`](observations.json): 35 submissions in total, 21 accepted and 14 refused. Every accepted entry carries the transaction hash a reader can look up independently. Every refused entry carries the ledger's or the decoder's verbatim error in place of a hash, because a refused transaction never reaches a chain.

This document is generated from `observations.json` by `scripts/chain-evidence-record.ts` and checked by the same script's `--check` mode, wired into `npm run verify`, so it cannot drift from the JSON it reads. [`chain-evidence/README.md`](README.md) documents that JSON's own format and why it is authored rather than generated. [`spec/06-chain-exercises.md`](../spec/06-chain-exercises.md) narrates what these exercises mean and why each ceiling sits where it does; this document does not repeat that narrative, only the enumerated record underneath it, grouped here by the question each submission answers rather than by the order it happens to sit in the file.

Every accepted hash below links to its transaction on [Cexplorer](https://cexplorer.io/)'s preprod instance, so a reader can confirm the outcome without trusting this repository. A refused submission never reaches a chain and so never has a hash to link; its row states that in words rather than a blank cell.

## Degenerate thresholds

_What happens to an empty `all`, an empty `any`, or a threshold that is zero or negative?_

- **Accepted** on preprod, [`74aa539069a5b4c84a63649c9cf18bc71c0bd813ff1cb28b7226d431ff00a83c`](https://preprod.cexplorer.io/tx/74aa539069a5b4c84a63649c9cf18bc71c0bd813ff1cb28b7226d431ff00a83c). An `all []` address was spent with no vkey witness at all and accepted: an empty `all` is satisfied by construction, so anyone holding the script can spend it. Corpus vector `degenerate/empty-all`. Source: spec/03-satisfaction.md, "Degenerate thresholds".
- **Accepted** on preprod, [`5bf18ed8f19463ae102b24bf920f74a1e7665d4cec343bf93ebf132454f99840`](https://preprod.cexplorer.io/tx/5bf18ed8f19463ae102b24bf920f74a1e7665d4cec343bf93ebf132454f99840). atLeast(0, []) was spent with no vkey witness: a non-positive threshold is satisfied on entry, before the empty child list is even consulted. Corpus vector `degenerate/empty-atleast-0`. Source: spec/03-satisfaction.md, "Degenerate thresholds".
- **Accepted** on preprod, [`cf05ba2db6ca337655f94e3b081a4ca4c6682c6c5e9e5f9f6b8b0d39a2eb1989`](https://preprod.cexplorer.io/tx/cf05ba2db6ca337655f94e3b081a4ca4c6682c6c5e9e5f9f6b8b0d39a2eb1989). `any []`, a script that can never be satisfied, was stored as a reference script output. Nothing executes a reference script, so satisfiability is irrelevant to whether it can reach the chain, and it is now permanently visible there. Corpus vector `degenerate/empty-any`. Source: spec/01-script-model.md, "What it takes for a script to reach the chain".
- **Accepted** on preprod, [`c45881950029d5545bec2550068050be388db0a464172895134a449df0d4215b`](https://preprod.cexplorer.io/tx/c45881950029d5545bec2550068050be388db0a464172895134a449df0d4215b). atLeast(0, [sig, sig, sig]) was spent with no vkey witness: a non-positive threshold is satisfied even though the script names three signers, because `isValidMOf` returns before looking at a single child. Corpus vector `threshold-matrix/atleast-0-of-3`. Source: spec/03-satisfaction.md, "Degenerate thresholds".
- **Accepted** on preprod, [`b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2`](https://preprod.cexplorer.io/tx/b1db2a411cb651a413840d3c8b112895a5bda2519a8ba6a372b8dd1ffc7746c2). atLeast(-1, [sig, sig]) was spent with no vkey witness: a negative threshold, representable because the CDDL types it as int64, is satisfied the same way a zero threshold is. Corpus vector `degenerate/atleast-negative`. Source: spec/03-satisfaction.md, "Degenerate thresholds".
- **Refused** on preprod. No transaction reached a chain. An `any []` address refused every spend attempt: an empty `any` can never be satisfied, so the funds it holds are locked permanently. Corpus vector `degenerate/empty-any`. Source: spec/03-satisfaction.md, "Degenerate thresholds".

  ```
  ConwayUtxowFailure (ScriptWitnessNotValidatingUTXOW (fromList [ScriptHash "52dc3d43b6d2465e96109ce75ab61abe5e9c1d8a3c9ce6ff8a3af528"]))
  ```

## Time bounds and validity intervals

_Does a timelock enforce its bound, and what happens when the transaction states no validity interval at all?_

- **Accepted** on preprod, [`aecef57696d8ea556442a8f305b5768e3ad9fb219561d02516eddbdbeca656e2`](https://preprod.cexplorer.io/tx/aecef57696d8ea556442a8f305b5768e3ad9fb219561d02516eddbdbeca656e2). `all [ sig(k), before(18446744073709551615) ]` was accepted: a `before` at the largest representable slot constrains nothing, but the transaction still had to declare a validityEnd, because an absent bound fails a timelock rather than passing it. Source: spec/03-satisfaction.md, "Extreme and invalid time bounds".
- **Accepted** on preprod, [`6ce721421b4b0994b7cf268cb0be84165dbaf0c2da1f8a112b36afb808f05346`](https://preprod.cexplorer.io/tx/6ce721421b4b0994b7cf268cb0be84165dbaf0c2da1f8a112b36afb808f05346). `all [ sig(k), after(133000000) ]` was accepted once `validityStart` was set to the locked slot. The identical signature, on a transaction with no validity interval, was refused with `ScriptWitnessNotValidatingUTXOW`, confirming that an absent interval bound fails the timelock rather than being skipped. Source: spec/03-satisfaction.md, "A timelock against an absent interval bound fails".
- **Refused** on preprod. No transaction reached a chain. `all [ sig(k), before(0) ] ` was refused: `before(0)` needs `validityEnd <= 0`, so the transaction is refused for being outside its own validity interval before the script is evaluated at all. Source: spec/03-satisfaction.md, "Extreme and invalid time bounds".

  ```
  OutsideValidityIntervalUTxO
    (ValidityInterval {invalidBefore = SNothing, invalidHereafter = SJust (SlotNo 0)})
    (SlotNo 133854816)
  ```
- **Refused** on preprod. No transaction reached a chain. `all [ sig(k), after(18446744073709551615) ] ` was refused: satisfying `after` at the largest representable slot needs a validity start about 585 billion years away, so the transaction is refused for being outside its own validity interval. Source: spec/03-satisfaction.md, "Extreme and invalid time bounds".

  ```
  OutsideValidityIntervalUTxO
  ```
- **Refused** on preprod. No transaction reached a chain. `all [ sig(k), before(-1) ] ` was refused: a negative slot is not in the grammar, so encoding one as CBOR major type 1 makes the whole transaction undecodable, and the refusal is the decoder's rather than the script's. Source: spec/03-satisfaction.md, "Extreme and invalid time bounds".

  ```
  DecoderErrorDeserialiseFailure
  ```
- **Refused** on preprod. No transaction reached a chain. `all [ sig(k), after(133000000) ] ` was refused when the spending transaction set no validity interval at all, on an otherwise correct signature: an absent interval bound fails the timelock rather than being skipped. Source: spec/03-satisfaction.md, "A timelock against an absent interval bound fails".

  ```
  ConwayUtxowFailure (ScriptWitnessNotValidatingUTXOW ... ScriptHash "036b3fb6...")
  ```

## Malformed and out-of-range script bytes

_What happens to a script, or a slot value inside one, that the CBOR grammar does not admit?_

- **Refused** on preprod. No transaction reached a chain. A reference script carrying `after(-1)`, a slot value outside `uint`, was refused. The decoder catches this, not script validation, so the failure names no script. Source: spec/01-script-model.md, "What it takes for a script to reach the chain".

  ```
  DecoderErrorDeserialiseFailure
  ```
- **Refused** on preprod. No transaction reached a chain. A reference script carrying bytes that are not CBOR at all was refused. `script_ref` wraps its content in a byte string, so the surrounding transaction stays well formed, but the decoder still looks inside and refuses what it finds. Source: spec/01-script-model.md, "What it takes for a script to reach the chain".

  ```
  DecoderErrorDeserialiseFailure
  ```
- **Refused** on preprod. No transaction reached a chain. A script naming `after(-(2^64-1))`, a slot far outside `uint` in the other direction, was refused identically to `after(-1)`: the failure is the same at any magnitude, because the problem is the type rather than the size. Source: spec/01-script-model.md, "What it takes for a script to reach the chain".

  ```
  DecoderErrorDeserialiseFailure
  ```

## Nesting depth

_How deep can a single script actually nest before something refuses it?_

- **Accepted** on preprod, [`f90dce5765108da976abdbb9fc618f9a6ffd9fa4d93b2f288eed1808545424c9`](https://preprod.cexplorer.io/tx/f90dce5765108da976abdbb9fc618f9a6ffd9fa4d93b2f288eed1808545424c9). A single key nested 5,383 `all` wrappers deep still spent in one transaction with one signature. One level further was refused for size (`MaxTxSizeUTxO`, supplied 16385 expected 16384), which settles that no recursion limit binds before `maxTxSize` does. Shape: nesting depth 5,383, script 16,181 bytes, transaction 16,383 bytes. Source: spec/06-chain-exercises.md, "How deep a single script can nest".
- **Refused** on preprod. No transaction reached a chain. A single key nested 5,384 `all` wrappers deep, one level past the 5,383-level script that spent, was refused for size: the node reports `MaxTxSizeUTxO` and says nothing about the script. This is the boundary the 5,383 ceiling is measured against. Shape: nesting depth 5,384, script 16,184 bytes, transaction 16,386 bytes. Source: spec/06-chain-exercises.md, "How deep a single script can nest".

  ```
  MaxTxSizeUTxO supplied 16385 expected 16384
  ```

## Multisig size ceilings

_How large can a single unanimous multisig be, carried inline and carried by reference?_

- **Accepted** on preprod, [`1d40d02c1b63a5eac942ff18c9731b457b502ca732820279a87c1a6f3f2bb140`](https://preprod.cexplorer.io/tx/1d40d02c1b63a5eac942ff18c9731b457b502ca732820279a87c1a6f3f2bb140). A 122-of-122 unanimous multisig, script carried inline, spent in a 16,334-byte transaction. A 123-of-123 attempt was refused for size (`MaxTxSizeUTxO`, supplied 16466 expected 16384). Shape: 122 signing keys named in the script, transaction 16,334 bytes. Source: spec/06-chain-exercises.md, "How large a single multisig can be", "Confirmed on preprod".
- **Accepted** on preprod, [`ebccf64ce29571dde8bfaf2e7f741582254a937cf862082188ffa697d00cffd3`](https://preprod.cexplorer.io/tx/ebccf64ce29571dde8bfaf2e7f741582254a937cf862082188ffa697d00cffd3). A 160-of-160 unanimous multisig, its 5,126-byte script carried as a reference input rather than inline, spent in a 16,298-byte transaction. A 161-of-161 attempt was refused for size (`MaxTxSizeUTxO`, supplied 16398 expected 16384). The node's fee demand for the reference script matched this project's own tiered reference-script fee arithmetic to the lovelace. Shape: 160 signing keys named in the script, script 5,126 bytes, transaction 16,298 bytes. Source: spec/06-chain-exercises.md, "How large a single multisig can be", "Confirmed on preprod".
- **Refused** on preprod. No transaction reached a chain. A 123-of-123 unanimous multisig, one member past the 122-of-122 script that spent inline, was refused for size. This is the boundary the 122-member inline ceiling is measured against. Shape: 123 signing keys named in the script, transaction 16,467 bytes. Source: spec/06-chain-exercises.md, "How large a single multisig can be", "Confirmed on preprod".

  ```
  MaxTxSizeUTxO supplied 16466 expected 16384
  ```
- **Refused** on preprod. No transaction reached a chain. A 161-of-161 unanimous multisig, one member past the 160-of-160 script that spent by reference, was refused for size. This is the boundary the 160-member by-reference ceiling is measured against. Shape: 161 signing keys named in the script, transaction 16,399 bytes. Source: spec/06-chain-exercises.md, "How large a single multisig can be", "Confirmed on preprod".

  ```
  MaxTxSizeUTxO supplied 16398 expected 16384
  ```

## Federations of federations

_How large a federation of member organizations, each governed by its own threshold, can be created and spent?_

- **Accepted** on preprod, [`26ea4c57248974265629c5513c66a4011cc596286f7128a2bc3b57b71aa4caca`](https://preprod.cexplorer.io/tx/26ea4c57248974265629c5513c66a4011cc596286f7128a2bc3b57b71aa4caca). Eight member organizations of 23, each satisfied by an internal majority of 12, 184 members and 96 signatures in total, spent through a 5,923-byte script in a 15,721-byte transaction. Shape: 184 signing keys named in the script, script 5,923 bytes, transaction 15,721 bytes. Source: spec/06-chain-exercises.md, "Federations, and which constraint actually binds", "Confirmed on preprod".
- **Accepted** on preprod, [`28afe751287e7f5ee7df73545027960ea0cb1687d07a64937550f0fdac1c0b83`](https://preprod.cexplorer.io/tx/28afe751287e7f5ee7df73545027960ea0cb1687d07a64937550f0fdac1c0b83). Twenty-four member organizations of 20, each satisfied by any one member, 480 members and 24 signatures in total, spent through a 15,460-byte script carried as a reference input in a 2,562-byte spending transaction. The script's root list holds 24 entries, so cardano-binary frames it indefinitely, while every 20-entry group list is framed definite: the framing rule applies per list rather than per script. Shape: 480 signing keys named in the script, script 15,460 bytes, transaction 2,562 bytes. Source: spec/06-chain-exercises.md, "Federations, and which constraint actually binds", "Confirmed on preprod".

## Encoding divergence

_Do the definite and cardano-binary framings of the same script interoperate on chain, or does a node treat them as two different scripts?_

- **Accepted** on preprod, [`71c07ab887ae65a02a7c9dae74cae970ea8a471ad3437a73d4fc3d074478124d`](https://preprod.cexplorer.io/tx/71c07ab887ae65a02a7c9dae74cae970ea8a471ad3437a73d4fc3d074478124d). An `any` of 24 key hashes, one of them a held key, was funded at its definite-framed address and spent with definite-framed script bytes. Shape: 24 signing keys named in the script. Source: spec/07-encoding-divergence.md, "Confirmed on chain".
- **Accepted** on preprod, [`7376f87c11960bf638c1fb3b6c2f23e2a3b9e2521ed106b3bd332a5c10a1fe72`](https://preprod.cexplorer.io/tx/7376f87c11960bf638c1fb3b6c2f23e2a3b9e2521ed106b3bd332a5c10a1fe72). The same script, funded separately at its cardanoBinary-framed address, was spent with cardanoBinary-framed script bytes. A definite address spent with cardanoBinary bytes was refused, naming both the missing definite hash and the extraneous cardanoBinary hash in one error: the two encodings do not interoperate. Shape: 24 signing keys named in the script. Source: spec/07-encoding-divergence.md, "Confirmed on chain".
- **Refused** on preprod. No transaction reached a chain. Spending the definite-framed address of the 24-key-hash `any` script with cardanoBinary-framed script bytes was refused. The credential wanted the definite hash; the witness supplied the cardanoBinary one; the node treats the two encodings as unrelated scripts. Shape: 24 signing keys named in the script. Source: spec/07-encoding-divergence.md, "Confirmed on chain".

  ```
  ConwayUtxowFailure (MissingScriptWitnessesUTXOW
    (fromList [ScriptHash "b7e9fae91f0bd2119ee47c75379439345ec0a5116515e8cea326efcc"]))
  ConwayUtxowFailure (ExtraneousScriptWitnessesUTXOW
    (fromList [ScriptHash "cca7321c5acd49f6dcda429401c054adc5724b424774c6097e9bc8ca"]))
  ```

## The DRep credential, end to end

_Does a native script work as a DRep credential through registration, a vote, an update and retirement?_

- **Accepted** on preprod, [`31ec4648ea0ce886d0ca0abda3ea839be56dfc2acf1070a57f981f66e2f5d286`](https://preprod.cexplorer.io/tx/31ec4648ea0ce886d0ca0abda3ea839be56dfc2acf1070a57f981f66e2f5d286). A 3-of-5 board registered as a DRep with the 500 ADA deposit, script hash ce021f147f597c5b48affb3d51de3be142ffd9fd898e8631b4948964, satisfied by three of the five board signatures. Shape: 5 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (DRep).
- **Accepted** on preprod, [`ae52f76f442fbe6ad53bda43d83d1e8a402ea6132c9a8d4ef825f85c7f9df46d`](https://preprod.cexplorer.io/tx/ae52f76f442fbe6ad53bda43d83d1e8a402ea6132c9a8d4ef825f85c7f9df46d). The same 3-of-5 board cast a Yes vote on an open governance action, again satisfied by three of the five board signatures. The vote reads back from an indexer's `drep_votes` query against the credential's CIP-129 identifier as `Yes` against the action it was cast on. Shape: 5 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (DRep).
- **Accepted** on preprod, [`3770ba2b45cbcdc3217793d30ac845f23f6e7b7714bf1a59b365745fe0207270`](https://preprod.cexplorer.io/tx/3770ba2b45cbcdc3217793d30ac845f23f6e7b7714bf1a59b365745fe0207270). The same 3-of-5 board submitted a DRep update, satisfied by three of the five board signatures. Shape: 5 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (DRep).
- **Accepted** on preprod, [`f5822f80d4236138a9b913dac29c3545b0cd380b23144b7e878875ebef550854`](https://preprod.cexplorer.io/tx/f5822f80d4236138a9b913dac29c3545b0cd380b23144b7e878875ebef550854). The same 3-of-5 board retired the DRep registration and reclaimed the 500 ADA deposit. Shape: 5 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (DRep).

## The stake credential, end to end

_Does a native script work as a stake credential, and what exactly refuses a delegation?_

- **Accepted** on preprod, [`436d377b754b503d4319c65ead5ee17495c27688bee910fdcf6c3614e381065e`](https://preprod.cexplorer.io/tx/436d377b754b503d4319c65ead5ee17495c27688bee910fdcf6c3614e381065e). A 2-of-3 trustee credential, script hash 3a2640ad93281967ce64763495bf27064ddce92de689a067072a3b4e, registered as a stake credential with the 2 ADA deposit. Shape: 3 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (stake).
- **Accepted** on preprod, [`4e068e25cbdbe45f602d953bdb4a96e011cc961d4ca46ad4d6f7d81478ff6d44`](https://preprod.cexplorer.io/tx/4e068e25cbdbe45f602d953bdb4a96e011cc961d4ca46ad4d6f7d81478ff6d44). The same 2-of-3 trustee credential delegated to a stake pool, satisfied by two of the three trustee signatures. The identical delegation was refused beforehand with no script witness (`MissingScriptWitnessesUTXOW`, naming the credential hash) and with only one trustee signature (`ScriptWitnessNotValidatingUTXOW`); only the two-signature attempt, this transaction, was accepted. Shape: 3 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (stake) and "The delegation already tests the script".
- **Accepted** on preprod, [`3740d5d65f046d17197ce57bf6172e41d46c2a072b014549a7e8f31bff5227d2`](https://preprod.cexplorer.io/tx/3740d5d65f046d17197ce57bf6172e41d46c2a072b014549a7e8f31bff5227d2). The same 2-of-3 trustee credential retired and reclaimed the 2 ADA deposit, before a full epoch of delegation had elapsed, so this exercise does not confirm a withdrawal for the stake role. Shape: 3 signing keys named in the script. Source: spec/06-chain-exercises.md, "Confirmed on preprod" (stake).
- **Refused** on preprod. No transaction reached a chain. Delegating the 2-of-3 trustee stake credential with no script witness at all and no trustee signatures was refused, naming the credential hash as a missing script witness. Shape: 3 signing keys named in the script. Source: spec/06-chain-exercises.md, "The delegation already tests the script".

  ```
  MissingScriptWitnessesUTXOW
  ```
- **Refused** on preprod. No transaction reached a chain. Delegating the same 2-of-3 trustee stake credential with the script present but only one of the three trustee signatures was refused: the script is present but its threshold is not met. Shape: 3 signing keys named in the script. Source: spec/06-chain-exercises.md, "The delegation already tests the script".

  ```
  ScriptWitnessNotValidatingUTXOW
  ```
