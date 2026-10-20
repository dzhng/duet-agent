# Slice 01 — Pin the official inputs

## Contract

A fresh checkout can fetch the exact DeepSWE and Pier sources and prove that
the ten committed task identities still match their task metadata.

## Seam

`benchmarks/deepswe/src/manifest.ts` owns parsing and verification of the
committed manifest. It does not execute tasks or know about model arms.

## Verification

- Assert exactly ten unique task IDs.
- Assert every task exists in the pinned checkout and matches its repository,
  base commit, language, and image reference.
- Falsify by changing one task identity and confirm verification rejects it.
- Run Pier's no-model `nop`/`oracle` smoke before paid model work.

## Delegated choices

Internal JSON parsing and error wording are delegated. Upstream identities,
selection algorithm, task IDs, and verifier ownership are not.
