# Arachne

A harness and conformance corpus for Cardano native scripts.

Native scripts are the multisig and timelock primitive that DReps, treasuries and
governance bodies are built on. They are simple enough that everyone implements them,
and subtle enough that implementations quietly disagree. Arachne pins down what the
correct answers are and publishes them as data any language can assert against. Where
the real limits fall is a separate question, and only a script running on chain can
answer it.

## Three questions, kept apart

| Question                                                               | How it is answered                          | Needs a network |
| ---------------------------------------------------------------------- | ------------------------------------------- | --------------- |
| Does an implementation produce the same CBOR and the same script hash? | Byte comparison against a recorded encoding | No              |
| Does it agree on whether a witness set satisfies a script?             | Comparison against a reference evaluator    | No              |
| Does a real node accept a transaction carrying the script?             | Submission to preview or preprod            | Yes             |

Conflating these produces a pass or fail nobody can act on. Only the third can establish
a limit, because nesting depth and script size are properties of a running ledger rather
than of a data format.

## The finding that motivates the rest

The same logical native script has two valid CBOR encodings that hash differently.

`cardano-binary`, which sits under cardano-node and cardano-cli, frames a list as a
definite-length CBOR array up to 23 elements and an indefinite-length array from 24 up.
cardano-serialization-lib, MeshJS and most of the JavaScript ecosystem use a
definite-length array at every size.

| Children in one container | cardano-cli           | cardano-serialization-lib | Agree |
| ------------------------- | --------------------- | ------------------------- | ----- |
| 23                        | `b168c85f621e7751...` | `b168c85f621e7751...`     | yes   |
| 24                        | `70a5c7c6bfabe9d3...` | `6695681e5d3875e8...`     | no    |

So a multisig with 24 or more members in one cohort has two valid script hashes, two
valid addresses and two valid governance identifiers. Neither encoder is wrong: both
produce conforming CBOR and each toolchain is self-consistent, because the ledger
hashes whatever bytes it receives. It only bites when a script crosses between
toolchains, which is why it stays invisible until it does.

Arachne records both encodings for every vector and treats neither as canonical.
[spec/07-encoding-divergence.md](spec/07-encoding-divergence.md) covers when it bites
and what to do about it. The short version is to hash the bytes you received rather
than decoding and re-encoding them.

## Watching it stay true

That finding is a snapshot, and tool releases keep coming. `compat/` runs the current and
previous releases of cardano-cli, cardano-address, cardano-serialization-lib, MeshJS,
gouroboros, cardano-client-lib, pallas and PyCardano against the committed corpus, plus a
beta release wherever a tool publishes one. It records which side of the divergence each
one actually lands on, not which side its documentation claims. A daily workflow opens a
pull request when a new version has something to report; nothing under `compat/results/`
is computed by hand. [compat/README.md](compat/README.md) has the full account, including
why some of these tools sit on the same underlying encoder and why that means they only
count once as evidence.

## The corpus

`vectors/` holds a generated corpus: one file per script, each carrying the script, its
CBOR, its hash, every credential the hash can occupy, and the witness sets that do and
do not satisfy it.

```json
{
  "id": "federation/m20-c20-s11",
  "question": "Does a threshold over member organizations, each itself a threshold, evaluate seat by seat at the sizes a real federation reaches?",
  "encoding": {
    "definite": { "scriptHash": "...", "cborBytes": 12884 },
    "cardanoBinary": { "scriptHash": "...", "cborBytes": 12884 },
    "encodingSensitive": false
  },
  "credentials": {
    "definite": {
      "governance": { "drep": { "cip129": "drep1...", "cip105": "drep_script1..." } }
    },
    "cardanoBinary": { "...": "the same shape, derived from the other hash" }
  },
  "satisfaction": [{ "id": "0+1@unbounded", "signers": ["..."], "expected": true }],
  "onchain": []
}
```

The format is language-neutral on purpose. A port in PHP, Rust or Python claims
conformance by reading these files and reproducing what they record, with no network
access and no key material. The format is specified in
[spec/04-vector-format.md](spec/04-vector-format.md).

## Install

```
npm install @crypto2099/arachne
```

## Use

```ts
import { parseScript, scriptHash, evaluate, govIdCip129 } from '@crypto2099/arachne';

const script = parseScript({
  type: 'all',
  scripts: [
    { type: 'sig', keyHash: '40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83' },
    { type: 'after', slot: 1 },
  ],
});

scriptHash(script);
// '2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f'

govIdCip129(scriptHash(script), 'drep');
// 'drep1yv4vp94cvr45qllmf2y4tmc4cdm5hexxxtmdxvgfyheqymcz7rw5m'

evaluate(script, { signers: ['40f07fe0...'] }).satisfied;
// false. The signature is present, but the timelock has nothing to compare against.
```

A script combining a signature with a timelock cannot be satisfied by a transaction that
declares no validity interval, however many correct signatures it carries, because an
absent interval bound fails a timelock rather than passing it. An evaluator that checks
only signatures reports this satisfied and then watches the node refuse the transaction.

## Command line

```
npx arachne inspect script.json     hashes, credentials and structure
npx arachne encode script.json      JSON to CBOR hex, --as definite | cardanoBinary
npx arachne decode <hex>            CBOR hex to JSON, with the framing it used
npx arachne evaluate script.json --signer <keyHash> --start <slot>
npx arachne families                the generator families and the question each answers
```

`decode` reports which encodings would reproduce the bytes it read, which is how you
find out whether a script from the chain came from a Haskell tool or a JavaScript one.

`evaluate` prints the evaluation tree with a reason at every node, so a failure names
the condition that was not met rather than only the verdict.

## Develop

```
npm run verify            lint, typecheck, both offline suites, corpus check
npm test                  the offline suites
npm run test:unit         one suite
npx vitest run -t 'name'  one test
npm run vectors:build     regenerate the corpus
```

`npm run test:cli` cross-checks the whole corpus against cardano-cli and skips cleanly
when the binary is not on PATH.

`npm run test:chain` is where a corpus vector's own exercise plan will submit a script
automatically and spend testnet ADA. That automation is not yet implemented, so the
command currently has no tests to run. It is never part of the default run and needs the
configuration in `.env.example`. The results in
[spec/06-chain-exercises.md](spec/06-chain-exercises.md) were submitted separately, by
hand-built transactions, ahead of that automation.

## What is known and what is not

The encoding and evaluation rules are read from published sources rather than inferred:
the Conway ledger CDDL for the grammar, `evalTimelock` in the ledger for satisfaction,
CIP-19 for addresses, and CIP-129 with CIP-105 for governance identifiers.

The encoder is cross-checked against three independent implementations across the whole
corpus: cardano-serialization-lib for the `definite` encoding, and cardano-cli and
cardano-address for the `cardanoBinary` one. cardano-cli is the strongest of the three
on its own, since it shares cardano-api's serialization path with the node itself.
cardano-address matters for a different reason: it reimplements the `cardano-binary`
array-framing rule in its own code rather than linking the library, so its agreement
with cardano-cli is a second implementation reaching the same answer, not the same
dependency counted twice.

The third question now has two confirmed answers. A single key nested 5,383 levels deep
still spends in one preprod transaction, and one level further is refused for size. A
unanimous multisig tops out at 122 members with the script carried inline, and 160 with
it carried by reference. Both were found by submitting the boundary transaction itself
and reading the node's verdict, not by calculation alone.
[spec/06-chain-exercises.md](spec/06-chain-exercises.md) has the transaction hashes, two
federation shapes confirmed the same way, and the DRep and stake credential roles
exercised by registering, voting, delegating and retiring on preprod.

Most vectors still carry an empty `onchain` array. Six observations exist there so far,
all for the payment credential. The code that would submit an arbitrary corpus vector's
exercise automatically is not yet built, so both those and the results described above
came from purpose-built transactions instead. Most of those transactions exercised a
protocol limit that no corpus vector represents, so they have no `onchain` array to sit
in. [chain-evidence/observations.json](chain-evidence/observations.json) indexes every
transaction hash named anywhere in this specification, twenty-one in total, and
cross-references the ones that do belong to a vector back to it.

When a node eventually disagrees with the reference evaluator, the node is right, and the
defect is in the evaluator or the specification. How that is recorded is in
[spec/05-conformance.md](spec/05-conformance.md).

## Specification

[spec/](spec/) is the normative account: the script model, encoding, satisfaction, the
vector format, what conformance means, and what exercising a script on chain involves
for each credential role.

## License

Apache-2.0.
