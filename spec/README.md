# The Arachne specification

Arachne answers three questions about a Cardano native script, and keeps them apart
because they fail for different reasons and are proved by different means.

| Question                                                                | Decided by                                          | Where                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Does an implementation produce the same bytes and the same script hash? | Comparison against a recorded encoding, offline     | [02-encoding.md](02-encoding.md)               |
| Does it agree on whether a witness set satisfies the script?            | Comparison against the reference evaluator, offline | [03-satisfaction.md](03-satisfaction.md)       |
| Does a real node accept a transaction carrying the script?              | Submission to a public testnet                      | [06-chain-exercises.md](06-chain-exercises.md) |

Only the third question can establish a limit. Nesting depth, script size and every
other ceiling are properties of a running ledger, not of a data format, so no amount
of offline reasoning settles them. The first two questions are settled offline and completely,

## Documents

- [01-script-model.md](01-script-model.md). What a native script is, the JSON form,
  and the name inversion between the JSON tags and the CDDL fields.
- [02-encoding.md](02-encoding.md). CBOR, the script hash, and every credential a
  script hash can occupy: addresses, reward accounts, and governance identifiers.
- [03-satisfaction.md](03-satisfaction.md). The reference evaluator, stated as rules,
  with the three that implementations get wrong called out.
- [04-vector-format.md](04-vector-format.md). The normative shape of a vector file.
- [05-conformance.md](05-conformance.md). What an implementation must do to claim
  conformance, and what happens when a node disagrees with the reference evaluator.
- [06-chain-exercises.md](06-chain-exercises.md). What "exercised on-chain" means for
  each credential role, and the evidence an exercise has to produce.
- [07-encoding-divergence.md](07-encoding-divergence.md). Why a script with 24 or more
  sub-scripts in one container has two valid hashes, and which one to use when.

## Implementing a port

The corpus under `vectors/` is the executable half of this specification. A port in
any language claims conformance by reading those files and reproducing what they
record. It needs no network access and no key material to do so.

1. Parse `vectors/index.json` and load every vector it lists.
2. For each vector, encode `script` both ways and compare against
   `encoding.definite.cborHex` and `encoding.cardanoBinary.cborHex`. These are byte
   comparisons, not structural ones.
3. Hash each encoding and compare against its `scriptHash`.
4. Derive each credential in `credentials.definite` and `credentials.cardanoBinary` and
   compare the strings.
5. For each entry in `satisfaction`, evaluate the script against the case's signers
   and validity interval, and compare against `expected`.

A port that passes all five is conformant at the format version recorded in the file.
Conformance says nothing about transaction building, which is a separate concern and
not covered here.

## Reading order for the underlying standards

Every constant in this specification is taken from a published standard rather than
from a running implementation. Where a document here states a header byte or a
prefix, it cites the standard that defines it.

- CIP-19 for the address binary format.
- CIP-129 for governance identifiers.
- CIP-105 for the superseded governance forms that are still in circulation.
- CIP-1854 for the derivation path a multi-signature wallet's cosigner keys come from.
- The Conway-era ledger CDDL for the native script grammar itself.
