# The vector format

A vector is one script and everything known about it. The corpus is a directory of
vector files plus an index, committed to the repository and shipped in the npm package.

Vectors are generated, never handwritten. Editing one by hand is how a corpus stops
being evidence, so the conformance suite rebuilds every vector and compares. A hand
edit shows up as a failing test on the next run.

## Layout

```
vectors/
  index.json
  <family>/<case>.json
```

## The index

```json
{
  "formatVersion": 3,
  "generatedAt": "2026-09-15T21:09:16.032Z",
  "generator": "arachne@0.1.0",
  "families": [{ "name": "...", "question": "...", "count": 24 }],
  "vectorCount": 126,
  "satisfactionCaseCount": 1067,
  "observationCount": 3,
  "encodingSensitiveCount": 15,
  "digest": "b304a292...",
  "vectors": [
    {
      "id": "...",
      "family": "...",
      "path": "...",
      "scriptHash": "...",
      "cardanoBinaryScriptHash": "..."
    }
  ]
}
```

`digest` is taken over every vector's id and script hash. Two corpora with the same
digest contain the same scripts. It is the cheapest way for a consumer to notice that
the corpus it vendored has moved.

`formatVersion` changes whenever the file shape changes in a way a consumer must
notice. A port should refuse a version it does not know rather than read around the
difference.

## A vector

```json
{
  "formatVersion": 3,
  "id": "nested-threshold/outer3-inner2-k2",
  "family": "nested-threshold",
  "question": "Does a threshold nested inside another evaluate independently, or does it flatten?",
  "params": { "outer": 3, "inner": 2, "k": 2 },

  "script": { "type": "atLeast", "required": 2, "scripts": [] },
  "shape": { "depth": 3, "nodeCount": 6, "sigCount": 4, "keyHashes": ["..."] },
  "remarks": [],

  "encoding": {
    "definite": {
      "cborHex": "830302838200581c5eb8ee18...",
      "preimageHex": "00830302838200581c5eb8ee18...",
      "scriptHash": "e1dbbc8c8cb6e8504c679769a945d9287b93a1c8a4fe19b06cf10dd4",
      "cborBytes": 136
    },
    "cardanoBinary": {
      "cborHex": "830302838200581c5eb8ee18...",
      "preimageHex": "00830302838200581c5eb8ee18...",
      "scriptHash": "e1dbbc8c8cb6e8504c679769a945d9287b93a1c8a4fe19b06cf10dd4",
      "cborBytes": 136
    },
    "encodingSensitive": false
  },

  "credentials": {
    "definite": {
      "enterprise": {
        "mainnet": "addr1...",
        "preview": "addr_test1...",
        "preprod": "addr_test1..."
      },
      "baseScriptStake": {
        "mainnet": "addr1...",
        "preview": "addr_test1...",
        "preprod": "addr_test1..."
      },
      "reward": {
        "mainnet": "stake1...",
        "preview": "stake_test1...",
        "preprod": "stake_test1..."
      },
      "governance": {
        "drep": { "cip129": "drep1...", "cip105": "drep_script1..." },
        "ccCold": { "cip129": "cc_cold1...", "cip105": "cc_cold_script1..." },
        "ccHot": { "cip129": "cc_hot1...", "cip105": "cc_hot_script1..." }
      }
    },
    "cardanoBinary": { "...": "the same shape, derived from the other hash" }
  },

  "satisfaction": [
    {
      "id": "0+1@unbounded",
      "signers": ["..."],
      "expected": true,
      "expectedReason": "2 of 3 sub-scripts satisfied, 2 required"
    }
  ],

  "onchain": []
}
```

## Why a vector carries two of everything

A sub-script list has two valid CBOR framings, and they hash differently once a container
holds 24 or more entries. Neither is canonical: `definite` is what
cardano-serialization-lib and most JavaScript tooling emit, `cardanoBinary` is what
cardano-cli and cardano-node emit. See
[07-encoding-divergence.md](07-encoding-divergence.md).

So a vector records both, and `encodingSensitive` says whether they differ for this
script. Below 24 entries they are byte-identical and the flag is false, which is the
common case and costs a consumer nothing. Above it, the script has two valid hashes, two
valid addresses and two valid governance identifiers, and `credentials` carries a full
set derived from each.

The index mirrors this: each entry lists `scriptHash` for the definite encoding and
`cardanoBinaryScriptHash` for the other, and `encodingSensitiveCount` says how many
vectors in the corpus diverge.

## Field notes

`script` is in canonical JSON form: keys in a fixed order, so two implementations that
agree produce byte-identical files. This governs the file only. The CBOR has its own
canonical form and is what the hash is taken over.

`shape.sigCount` and `shape.keyHashes` differ whenever a key hash repeats. The
difference is the whole content of the `duplicate-keys` family.

`remarks` records structural oddities, each with a code and a path. A remark means the
oddity is deliberate, not that the vector is broken. An empty array is the common case.

Each encoding's `preimageHex` is redundant with its `cborHex`, deliberately. When a port's hash
disagrees, comparing the preimage separates a wrong language-tag prefix from wrong CBOR
in one step instead of two.

`satisfaction[].validityStart` and `validityEnd` are omitted rather than set to null
when the case leaves that bound unset. Omission is what an unbounded transaction
actually looks like, and the distinction is load-bearing: an absent bound fails a
timelock rather than passing it.

## Cosigner key hashes

Generated scripts contain key hashes derived from a label, not from a wallet:

```
keyHash = blake2b224( utf8("arachne/cosigner/" + label) )
```

Labels are `c0`, `c1`, and so on, with `lead0` and `deleg0` in the nested families. Any
implementation can regenerate them from the label with no key material.

These are not keys. No private key exists for them and nothing can sign for them. They
exist so that a vector's script hash reproduces exactly in every language. A chain
exercise needs real signing keys, gets them from `ARACHNE_COSIGNER_SEED`, and its
vectors record the key hashes that were actually used.

## Sampling

A script with six or fewer distinct keys gets the full power set of signer sets. Above
that the power set is unusable, and a full sweep is mostly redundant: for a flat
container, cardinality 200 establishes nothing that cardinality 3 did not.

What is not redundant is a cardinality that steps across a threshold. Above the limit
the builder derives its sample sizes from the `required` values actually present in the
script, taking one below, one on and one above each, plus the empty and full sets. Each
size contributes both a prefix and a suffix of the key list, because a positional bug
in a consumer shows up as one passing and the other failing.

Validity intervals are sampled the same way, from the slots the script actually
mentions: one below, one on and one above each, plus the unbounded case, which is
always present.

## The `onchain` array

Each observation carries the protocol parameters it was made under, in
`protocolParams`. A size result is only interpretable against the `maxTxSize` it was
measured against, and a timestamp cannot supply one, because a reader cannot recover a
past parameter set from a date.

Observations are evidence and are covered in [05-conformance.md](05-conformance.md) and
[06-chain-exercises.md](06-chain-exercises.md). The rule that governs this file format
is that a rebuild regenerates everything except `onchain`, which is carried forward
from the previous corpus by vector id.
