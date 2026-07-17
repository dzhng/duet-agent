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

## Inputs from the slice-03 review (orchestrator, 2026-07-18)

- Golden-corpus case to include: "the sidebar flickers when I toggle dark mode, fix the css
  transition" routed to `implement` (sol) on the first prompt draft. Per the map's intent
  (visual = "Frontend, 3D, or anything visual: UI, styling, graphics"), CSS/frontend fixes
  should hit `visual` (kimi). Expect label: visual.
- The built-in table's route descriptions were condensed by slice 02 relative to the map's
  richer prompt text (e.g. visual = "Tasks whose output or input depends on visual fidelity").
  Tuning should start by restoring the map's fuller wording per route, then measure.
- Probe latency observed at ~1.4s on vercel-ai-gateway (single sample) — above the ~1s p50
  target; measure properly before freezing the ceiling.

## Scorecard

Recorded 2026-07-18 against `gpt-5.6-luna` at low reasoning effort through
`vercel-ai-gateway` (`DUET_API_KEY=''`, `AI_GATEWAY_API_KEY` selected). The frozen corpus has 28
cases. No fixture labels changed during tuning.

### Tuning provenance

1. Restored the map's richer descriptions before changing the classifier prompt. In particular,
   `visual` again explicitly owns frontend, UI, CSS/styling, 3D, graphics, image inspection, and
   visual-fidelity work; `implement` explicitly owns non-visual backend/systems/data/CLI work. The
   economy descriptions make the text-only versus image-dependent implementation boundary explicit.
2. With those descriptions and prompt `model-router-classifier-v1`, the first 28-case trial scored
   27/28 (96.4%). Every family was 100% except `implement-visual` at 2/3 (66.7%): the economy
   screenshot-explanation case chose `general` because the classifier knew an image-capable model
   was required but was not told which route supplied one. Latency measured p50 1313 ms / p95
   1582 ms (15,113 tokens).
3. Froze the p50 ceiling at **1600 ms** before final prompt tuning. This gives about 22% headroom
   over the measured 1313 ms p50 and agrees with slice 03's 1234–1848 ms Vercel samples. The
   aspirational ~1s target was not an honest ceiling for the observed provider path.
4. Compared the two previous-turn hint shapes over the four required continuity/transition cases,
   three trials each. Both were 12/12 (100%). The **last-assistant-summary style wins** the tie: it
   retains semantic task state and measured p50/p95 1334/1541 ms, versus 1363/3935 ms for the
   last-N-tool-names style (7,104 versus 7,015 tokens). The scorecard fixtures therefore feed the
   summary-style hint by default.
5. Prompt `model-router-classifier-v2` names the tier's image-safe route in the rendered rules and
   directs image-bearing requests to it. The formerly failing economy screenshot case then passed
   3/3. This is prompt-only capability disclosure; resolution and schema behavior did not change.

### Final three-trial result

| Metric                     | Result                                        |
| -------------------------- | --------------------------------------------- |
| Overall exact-route        | **84/84 (100%)**                              |
| `visual`                   | **100%**                                      |
| `plan`                     | **100%**                                      |
| `implement`                | **100%**                                      |
| `writing`                  | **100%**                                      |
| `general`                  | **100%**                                      |
| `implement-visual`         | **100%**                                      |
| Core continuity/transition | **12/12 (100%)**                              |
| Hard invariants            | **100%** (real route names; image-safe route) |
| Latency                    | **p50 1332 ms / p95 2952 ms**                 |
| Classifier input           | **567 tokens max / 1000-token ceiling**       |
| Prompt                     | `model-router-classifier-v2`                  |
| Acceptance-run tokens      | **47,025**                                    |

The required prompt, “the sidebar flickers when I toggle dark mode, fix the css transition,”
selected `visual` in all three final trials.

### Falsification

After the green run, swapping the frontier/balanced `visual` and `implement` descriptions made the
one-trial suite fail: overall accuracy fell to **16/28 (57.1%)**, and both affected families fell to
**1/7 (14.3%)**. The CSS-transition case changed to `implement`, image safety failed, and every core
continuity/transition case failed. Restoring the descriptions restored the accepted configuration.

Total live tuning and falsification spend recorded by provider usage callbacks: **93,505 tokens**.
The provider catalog reported zero dollar cost for Luna, so tokens are the durable spend estimate.
