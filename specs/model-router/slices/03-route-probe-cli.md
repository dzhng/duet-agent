# 03 — Classifier + `duet route` probe + `duet config export` ★ first playable checkpoint

## Contract unlocked

The real classifier runs against the effective table from the terminal, printing route, concrete
model, effort, rationale, and resolution chain. This is the permanent prompt-tweaking workbench
and it lands **before any turn-runner wiring** (interview constraint).

## API seam

`src/model-routing/prompts.ts` — classifier section: `CLASSIFIER_SYSTEM_PROMPT`,
`renderClassifierRules(tier, guidance)`. First draft of the prompt text; tuned in slice 04. ALL
tunable prose lives in this file, forever.

`src/model-routing/classifier.ts`:

- `ClassifierInput` — tier rules, guidance, `currentTarget?`, bounded `prevTurnHint?`,
  `lastStepDelta?`, `hasImages`, trigger (`turn_start | cadence | advisor`). Lean by contract:
  never the full transcript.
- `buildClassifierMessages(input)` (pure) + `classifyRoute(input, {model, signal, onUsage}) →
{route, rationale}` via `generateStructuredOutput` (luna, low effort). The classifier picks a
  route **name** only — concrete model/effort always come from the validated table. An invented
  route name is an error surfaced, never silently accepted.
- **Seam fix that lands here:** thread `signal` through `StructuredOutputOptions` →
  `complete(..., {signal})` in `src/core/structured-output.ts` (map L5 groundwork; today no
  abort path exists).

`src/cli/route.ts` + dispatch in `src/cli.ts` (beside `model`, follow `src/cli/model.ts`
pattern):

```sh
duet route "<prompt>"                  # defaultTier
duet route --model economy "<prompt>"  # explicit tier
duet route --images "<prompt>"         # simulate attached images (exercises vision guard)
duet route --json "<prompt>"           # machine-readable RouteDecision (for evals/scripts)
duet config export [--force]           # write built-in table to .duet/models.json
```

Composition: `loadRoutingTable` → `buildClassifierMessages` → live `classifyRoute` →
`resolveRoute`. Prints latency ms (slice 04 asserts on it). Non-zero exit on classifier or
validation failure.

## What the human can run

The workbench loop: `duet config export` → edit `.duet/models.json` or `prompts.ts` →
`duet route "fix the flexbox on the settings page"` → watch the decision change. Any future live
misroute is reproducible here by construction.

## Verification

`test/cli-route.test.ts`: arg parsing, `--json` shape, tier-not-found, export/overwrite-refusal
(classifier stubbed). Live smoke: ~8 canonical prompts (visual / plan / implement /
implement-visual / writing / general / ambiguous / image-bearing) — outputs recorded in
`specs/model-router/assets/probe-baseline.md`.

## Must stay green

Slice 02 suites; existing CLI dispatch tests; `duet model` unchanged.

## Human review checkpoint (non-blocking)

Show the probe transcript for the canonical prompts + the exported JSON — these are the top two
tweakables (table contents, classifier prompt). ~5-minute window; if silent, proceed on the
evidence and record the verdicts here.

## Feedback that would change this slice

Wrong-feeling routes → edit prompt/table via the workbench (that's the point); output format
gripes → cheap iteration before the TUI mirrors it.

## Dependencies

Slices 01 (concrete names resolve) and 02.
