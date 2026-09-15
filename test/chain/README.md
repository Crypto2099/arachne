# Chain exercises

Tests in this directory submit real transactions to preview or preprod and spend testnet
ADA. They are a separate vitest project (`npm run test:chain`), are never part of the
default run, and are not run in CI.

They are empty because transaction construction is not implemented. The provider, the
exercise plans, the bundle budget arithmetic and the observation format are all in place;
what is missing is building and signing the transactions.

A test here must record its result into the corpus as a `ChainObservation` with a
transaction hash on acceptance or the node's verbatim error on rejection. It must never
write an observation for a transaction it did not submit. See spec/06-chain-exercises.md
for the contract.
