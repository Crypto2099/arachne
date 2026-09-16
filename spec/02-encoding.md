# Encoding

Everything in this document is decided offline and is a byte comparison. An
implementation either produces these bytes or it does not.

## CBOR

Native scripts use a tiny corner of CBOR: unsigned integers, one negative integer,
byte strings, and arrays. Every integer and byte string is shortest form.

Array framing is the exception, and it is the whole of
[07-encoding-divergence.md](07-encoding-divergence.md). A sub-script list is written
definite-length by cardano-serialization-lib and most JavaScript tooling at every size,
and by `cardano-binary`, and so by cardano-cli and cardano-node, only up to 23 entries,
switching to indefinite length from 24. Both produce valid CBOR and the two hash
differently, so neither is canonical and an implementation has to choose knowingly. The
worked examples below are small enough that the two coincide; read 07 before relying on
any of it for a container holding 24 or more.

The head byte carries a major type in its top three bits and an argument in the low
five. Arguments below 24 are written into the head byte; larger ones follow it in 1, 2,
4 or 8 bytes, always the shortest that fits.

| Major type | Used for                                                          |
| ---------- | ----------------------------------------------------------------- |
| 0          | Unsigned integers: tags, slots, and a non-negative `required`     |
| 1          | The negative half of `required`, encoded as -1 minus the argument |
| 2          | Byte strings: the 28-byte key hash                                |
| 4          | Arrays: the node itself and its child list                        |

Each node is an array whose first element is its tag:

```
sig      [0, h'<28 bytes>']
all      [1, [ <children> ]]
any      [2, [ <children> ]]
atLeast  [3, <required>, [ <children> ]]
after    [4, <slot>]
before   [5, <slot>]
```

A worked example, the two-node script `all[ sig(40f07f...), after(1) ]`:

```
82          array(2)
  01        unsigned(1)            the "all" tag
  82        array(2)               two children
    82      array(2)
      00    unsigned(0)            the "sig" tag
      581c  bytes(28)
            40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83
    82      array(2)
      04    unsigned(4)            the "after" tag, script_invalid_before
      01    unsigned(1)            slot 1
```

Producing:

```
8201828200581c40f07fe0321a211d8fddd174371586f18442ab5efe529b6252f53a83820401
```

## The script hash

The hash is blake2b with a 28-byte digest, taken over the language tag followed by the
script's CBOR. Native scripts are language 0.

```
scriptHash = blake2b224( 0x00 || cbor(script) )
```

The prefix is the step most often missed. Hashing the CBOR alone produces a
well-formed 28-byte value that corresponds to nothing. When a port's hash disagrees,
compare the preimage before anything else: every vector records a `preimageHex` under each encoding
for exactly this reason, and it localizes the fault to the prefix or the CBOR in one
step.

For the example above the hash is
`2ac096b860eb407ffb4a8955ef15c3774be4c632f6d3310925f2026f`, which is the DRep credential recorded in the Ekklesia fixtures and reproduced in
`test/unit/encode.test.ts`.

## Credentials

A script hash is a credential, and the same 28 bytes appear in every role a credential
can take. What changes is the envelope around them.

### Addresses, from CIP-19

An address is a header byte followed by one or two 28-byte credentials. The header's
high four bits are the address type and the low four are the network tag.

```
7 6 5 4 3 2 1 0
┌─┬─┬─┬─┬─┬─┬─┬─┐
│t│t│t│t│n│n│n│n│
└─┴─┴─┴─┴─┴─┴─┴─┘
```

Network tag 0 is every testnet and 1 is mainnet. Preview and preprod share tag 0, so a
given script has one address that is valid on both. That is a property of the format,
not an oversight in the corpus.

Odd address types carry a script payment credential. The types a script hash can
occupy:

| Type | Bits   | Payment                                       | Delegation        |
| ---- | ------ | --------------------------------------------- | ----------------- |
| 1    | `0001` | Script                                        | Stake key hash    |
| 3    | `0011` | Script                                        | Script            |
| 5    | `0101` | Script                                        | Pointer           |
| 7    | `0111` | Script                                        | None (enterprise) |
| 15   | `1111` | Reward address over a script stake credential |

Bech32 prefixes are `addr` and `addr_test` for addresses, `stake` and `stake_test` for
reward addresses.

Cardano addresses exceed the 90-character limit in BIP-173, and CIP-19 states that the
limit does not apply. An implementation using a bech32 library that enforces 90
characters will encode enterprise addresses correctly and fail on base addresses, which
presents as an unrelated bug. Disable the limit on both encode and decode.

### Governance identifiers, from CIP-129

A governance identifier is a header byte followed by the 28-byte credential. The
header's high four bits are the key type and the low four are the credential type.

| Key type | Bits   |
| -------- | ------ |
| CC hot   | `0000` |
| CC cold  | `0001` |
| DRep     | `0010` |

| Credential type | Bits   |
| --------------- | ------ |
| Key hash        | `0010` |
| Script hash     | `0011` |

Credential types 0 and 1 are reserved so that a governance identifier can never be
mistaken for an address, whose low nibble is a network tag.

A script DRep therefore has header `0x23`, a script CC cold credential `0x13`, and a
script CC hot credential `0x03`. The bech32 prefixes are `drep`, `cc_cold` and
`cc_hot`.

### The superseded forms, from CIP-105

CIP-105 encoded the bare 28-byte hash with no header, under a prefix that named the
credential kind: `drep_script`, `cc_cold_script`, `cc_hot_script`, and the key-hash
equivalents without the suffix. CIP-129 supersedes it, but wallets and indexers still
emit and accept the old form, so anything reading governance identifiers in the wild
has to handle both.

### The ambiguity that follows

`drep1...` belongs to both standards. Only the decoded length separates them.

| Decoded length | Standard | Contents                                                      |
| -------------- | -------- | ------------------------------------------------------------- |
| 29 bytes       | CIP-129  | Header byte plus hash. The credential type is recoverable     |
| 28 bytes       | CIP-105  | A bare key hash. The credential type is not recorded anywhere |

A resolver that assumes one form silently misreads the other, and the failure is quiet:
it produces a plausible 28-byte value either way. Reading the first byte to decide
between them is worse than useless, because a bare hash beginning `0x22` is an ordinary
hash and carries no signal at all.

Decode by length. A 28-byte payload under a `_script` prefix is known to be a script
credential from the prefix; a 28-byte payload under a bare `drep` prefix is a key hash
by CIP-105's definition, and nothing in the identifier confirms it.

Every vector records both forms for all three governance roles, so a consumer can test
its resolver against both without constructing them.
