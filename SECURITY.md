# Security Policy

## Supported versions

The most recent release on `main` is supported. Older versions receive no fixes.

## Reporting a vulnerability

Report privately through GitHub's security advisory form on this repository, under
Security, then Report a vulnerability. Do not open a public issue.

Please include what an attacker can do, the steps to reproduce it, and the version or
commit you tested.

You can expect an acknowledgment within a week. Once a fix is available it ships in a
normal release and an advisory is published so that watchers and dependency scanners
pick it up.

## Scope

Arachne is a test harness and a corpus of test data. It handles no funds, holds no
keys in normal use, and is not deployed as a service.

Report either of the following:

- An error in the encoding, hashing, credential derivation or satisfaction rules. A
  consumer relying on a wrong answer here can accept an authentication attempt it should
  refuse, which is the practical risk this project carries.
- Anything that causes the chain exercises to touch mainnet or to use key material other
  than what was configured for a testnet.

The cosigner key hashes in the corpus are derived from labels and have no private keys.
They are not secrets and are not a finding.
