# The encoding divergence

The same logical native script has two valid CBOR encodings that hash differently. A
script with 24 or more sub-scripts in any one container therefore has two valid script
hashes, two valid addresses, and two valid governance identifiers. Which one the chain
holds depends on which tool created it.

This is not a bug in either encoder. Both produce well-formed CBOR, both decode
correctly, and each toolchain is self-consistent. It only bites when a script crosses
between toolchains.

## The rule

`cardano-binary`, the serialization library underneath `cardano-ledger`,
`cardano-api`, `cardano-cli` and `cardano-node`, frames a list like this:

```haskell
wrapCBORArray :: Word -> Encoding -> Encoding
wrapCBORArray len contents
  | len <= 23 = encodeListLen len <> contents
  | otherwise = encodeListLenIndef <> contents <> encodeBreak
```

Up to 23 elements it writes a definite-length array. From 24 it writes an
indefinite-length array (`0x9f`) closed by a break (`0xff`).

cardano-serialization-lib, MeshJS and most of the JavaScript ecosystem write a
definite-length array at every size.

24 is not an arbitrary threshold. It is where a CBOR array header stops fitting in the
head byte and needs a following length byte, so it is the point at which a
streaming encoder that does not know its length in advance starts preferring the
indefinite form.

## What it looks like

A 24-signature `all`, encoded both ways:

```
definite       82 01 98 18 8200581c...    array(2), tag 1, array(24), children
cardanoBinary  82 01 9f    8200581c... ff array(2), tag 1, array(*), children, break
```

Same script, different bytes, different hash:

| Children | cardano-cli           | cardano-serialization-lib | Agree |
| -------- | --------------------- | ------------------------- | ----- |
| 23       | `b168c85f621e7751...` | `b168c85f621e7751...`     | yes   |
| 24       | `70a5c7c6bfabe9d3...` | `6695681e5d3875e8...`     | no    |
| 50       | `ac845b3aed05d881...` | `c903bdc63fce124c...`     | no    |

## Why it has gone unnoticed

Almost no real script reaches 24 sub-scripts in one container. A 3-of-5 treasury, a
2-of-3 DRep and a 7-of-10 committee are all far below the line, and below it the two
encodings are byte-identical. The divergence is invisible until an organisation grows a
cohort past 23, at which point it appears all at once.

It is also self-concealing. A team using one toolchain end to end never sees it: the
address it derives matches the hash it submits, because both came from the same
encoder, and the ledger hashes whatever bytes it receives. The failure needs two tools.

## When it bites

- An address or governance identifier is derived with one tool and the transaction is
  built with another. The script hash in the witness will not match the credential
  being spent or voted with, and the transaction is rejected.
- A backend verifies a DRep script hash fetched from an indexer against a hash it
  recomputes from the script JSON. If the two came from different encoders, a correct
  signature set is refused.
- A script is decoded from the chain and re-encoded before hashing. Re-encoding in the
  wrong framing silently changes the hash.

The last one is the easiest to hit and the hardest to see, because nothing about the
code looks wrong.

## What to do

**Hash the bytes you received.** When a script arrives as CBOR, from an indexer, a
transaction or a peer, take its hash over those exact bytes. Do not decode and
re-encode first. `scriptHashFromCbor` does this, and it is what the ledger does, which
retains the original bytes for hashing rather than recomputing them.

**When you only have JSON, compute both.** `scriptHashes` returns both hashes and a
flag saying whether they differ. Below 24 children they are equal and the flag is
false, so the common case costs nothing.

```ts
const { definite, cardanoBinary, encodingSensitive } = scriptHashes(script);
if (encodingSensitive) {
  // Two valid hashes. Accept either, or find out which tool made this one.
}
```

**Say which encoding you mean.** `encodeScript(script, 'cardanoBinary')` and
`scriptHash(script, 'cardanoBinary')` take it explicitly. The default is `definite`,
matching the JavaScript ecosystem this library sits in, but a caller talking to
cardano-cli or a node wants the other one.

**Check what the decoder tells you.** `decodeScript` reports which encodings would
reproduce the bytes it read:

| `framings`                      | Meaning                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `['definite', 'cardanoBinary']` | Every list is under 24, so the two agree                                    |
| `['definite']`                  | Produced by CSL, MeshJS or similar                                          |
| `['cardanoBinary']`             | Produced by cardano-cli, a node, or Haskell tooling                         |
| `[]`                            | Neither standard encoder produces these bytes. Re-encoding changes the hash |

## Confirmed on chain

The divergence was tested on preprod with an `any` of 24 key hashes, one of them a key we
held, so a single signature spends it. The two encodings gave two addresses, both funded
from the same transaction.

| Attempt                                               | Result                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Definite address, spent with definite bytes           | Accepted, `71c07ab887ae65a02a7c9dae74cae970ea8a471ad3437a73d4fc3d074478124d` |
| cardanoBinary address, spent with cardanoBinary bytes | Accepted, `7376f87c11960bf638c1fb3b6c2f23e2a3b9e2521ed106b3bd332a5c10a1fe72` |
| Definite address, spent with cardanoBinary bytes      | Refused                                                                      |

The refusal names both hashes in one error, which is as direct a statement of the problem
as the ledger can make:

```
ConwayUtxowFailure (MissingScriptWitnessesUTXOW
  (fromList [ScriptHash "b7e9fae91f0bd2119ee47c75379439345ec0a5116515e8cea326efcc"]))
ConwayUtxowFailure (ExtraneousScriptWitnessesUTXOW
  (fromList [ScriptHash "cca7321c5acd49f6dcda429401c054adc5724b424774c6097e9bc8ca"]))
```

The credential wanted the definite hash. The witness supplied the cardanoBinary one. Both
are valid encodings of the same logical script, and the node treats them as two unrelated
scripts, because to the ledger that is exactly what they are.

So both halves of this document are now observed rather than reasoned: each encoding
works end to end within its own toolchain, and crossing between them fails.

## Which one is right

Neither, and that is the point. The ledger accepts both, and the CDDL constrains
structure rather than framing, so both are conforming. `cardanoBinary` is what the node
itself emits, which makes it the one to match when interoperating with cardano-cli.
`definite` is what most of the ecosystem's tooling emits, which makes it the one
already recorded on chain for scripts built by wallets.

Arachne records both for every vector and treats neither as canonical. A port claims
conformance by reproducing both.

## The boundary in the corpus

The `encoding-boundary` family holds the divergence point at 23 and 24 children, in
three positions: at the root, nested under a small container, and nested two levels
down. The nested cases matter because `cardano-binary` frames each list independently,
so a script whose root holds two children still diverges if one of those children holds 24. An implementation that checks only the root's child count will conclude a script is
safe when it is not.

`breadth` covers 23, 24 and 25 as well as the larger widths, so the boundary is
bracketed from both sides.
