# 01 — Catalog + gateway reality (kimi-k3, gpt-5.6-sol, gpt-5.6-terra)

## Contract unlocked

Every concrete model in the default routing table is provably reachable with correct effort,
vision capability, and caps — or the table contents change now, before anything is built on them.

## API seam

`src/model-resolution/catalog.ts` (`MODEL_DEFINITIONS`): entries for `kimi-k3`
(`moonshotai/kimi-k3`, `input: ["text","image"]`, 1M context window, explicit output cap),
`gpt-5.6-sol` and `gpt-5.6-terra` (`openai/gpt-5.6-sol|terra` — the `openai/` prefix routes them
onto the openai-responses transport where `reasoningEffort` survives, `duet-gateway.ts:69-74`;
confirm, don't assume). `src/model-resolution/duet-gateway.ts`: if the kimi spike shows effort is
swallowed on the synthesized anthropic-messages path, add one named passthrough/clone branch
owned here — call sites never special-case.

**Landmine this slice kills** (risk-first draft recon): without a real catalog entry, kimi falls
to `synthesizePassthroughModel` which declares it **text-only** with a 256k window
(`duet-gateway.ts:91-108`) — the vision guard would then route images _away_ from the vision
model. The catalog entry with `input: ["text","image"]` is the fix.

## What the human can run

`duet --model kimi-k3 "<prompt with an attached image>"` works end-to-end;
`duet --model gpt-5.6-sol "<prompt>"` shows reasoning output at high effort.

## Verification

- Unit tests (extend catalog/resolver coverage): the three shorthands canonicalize, resolve on
  both gateway providers, and carry the expected `input`/`contextWindow`/output caps.
- Kimi effort spike with **wire evidence**: capture the outgoing request (`onPayload` or
  equivalent) proving the effort parameter is present, and record the finding in this file.
  Never display "high" for kimi anywhere unless the wire shows it. **Resolves map OPEN #1.**
- Optional: extend `evals/model-direct.eval.ts` with one live kimi image call (docker-gated).

## Must stay green

`test/cli-model.test.ts`, `test/duet-gateway-base-url.test.ts`, resolver tests, `duet model` CLI.

## Feedback that would change this slice

Kimi refusing effort entirely → the table's visual routes may drop to a different effort or model;
that is a one-line table edit in slice 02's built-in table, not a redesign.

## Dependencies

None. Parallel with slice 02.
