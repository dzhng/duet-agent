# 04 — Classifier scorecard eval + tuning pass 1

## Contract unlocked

The classifier prompt, route descriptions, continuity hint, and `guidance` become measured
artifacts with a regression floor — not untested prose. The map's open prompt-design question
(prev-turn hint shape) is resolved by measurement.

## API seam

`evals/fixtures/model-routing/golden-prompts.json` — frozen corpus,
`Array<{prompt, tier, hasImages?, expectedRoute: string|string[], note?}>`, ~20-30 cases:
visual creation, screenshot/UI implementation, planning/architecture, backend implementation,
creative writing, general questions, economy implement-visual, image-bearing prompts (vision
guard), **paired continuity cases** (lexical change, same task → should NOT switch) and **paired
transition cases** (genuine task change → should switch).

`evals/model-routing-classifier.eval.ts` — docker-gated, live luna, `EVAL_MODEL` override,
drives cases through `classifyRoute` (the probe's exact code path). Per-failure record: expected,
actual, rationale, prompt version, latency, tokens.

## Quality gates (freeze labels before tuning)

- Hard invariants (no invented route names; image cases obey the vision guard): 100%.
- Overall exact-route accuracy across 3 trials: ≥ 90%; no route family below 80%.
- Continuity/transition pairs: required core cases all pass.
- Classifier input under a fixed token ceiling; p50/p95 latency recorded and a ceiling frozen
  (~1s p50 target) **before** final tuning — the always-on default makes latency a product
  gate, not a nicety. **Resolves map OPEN: latency ceiling.**
- **Falsification:** swap the visual and implement route descriptions → eval must fail.
- Relabeling a fixture requires a recorded product rationale in this file — labels are oracles,
  not tuning knobs.

## Tuning pass 1 (scope firewall)

May edit only: `prompts.ts`, route `description` strings, bounded-context shaping (hint sizing).
Measure the map's toggleable alternative here: prev-turn hint as last-assistant-summary vs
last-N-tool-names, judged on the continuity corpus; record the winner and scores. Each prompt
edit logged with before/after scores (tuning provenance).

## What the human can run

`bun test evals/model-routing-classifier.eval.ts` (docker) for the slow loop; `duet route` for
the fast loop. Red eval → edit → probe the failing case → green.

## Must stay green

Slice 03 probe behavior and suites; the falsification check itself.

## Human review checkpoint (non-blocking)

Scorecard + final prompt text + golden set shared; the user may add/veto cases. ~5-minute
window, then decide from measured failures and record.

## Dependencies

Slice 03.
