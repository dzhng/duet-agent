# 06 — Hard cutover: frontier default + virtual-aware command surfaces

## Contract unlocked

`frontier` is the default model, period — no opt-out flag, no compat shim, no migration. Every
place a model name enters the system accepts virtuals. Dogfood starts here: daily use is the
always-on latency/quality experiment (that's deliberate — "classifier latency must be invisible"
is only falsifiable by dogfood; `/model <concrete>` is the escape hatch).

## API seam

- Boot default: `src/model-routing/` owns `DEFAULT_MODEL_SELECTION = "frontier"`; the concrete
  `DEFAULT_CLI_MODEL` stays concrete for the paths that need it. Boot resolution checks
  `isVirtualModel` **before** `canonicalizeModelName`/`pinnedDefaultModel` — `pinnedDefaultModel`
  and the `--provider` pin path (`run.ts:230-243`) must never see a virtual name (map L3).
  `--provider` keeps producing a concrete pin (bypasses routing).
- `Session.setModel` (`session.ts:376-385`): virtual name → activate routing / retarget +
  `router.unpin()`; concrete name → existing validation + `router.pin()`. `/model` confirmation
  reads honestly: `next turn routes via frontier` vs `pinned to gpt-5.6-sol`.
- `src/tui/slash-commands.ts` (`/model`, help text) and `src/cli/inline-slash.ts:43` — the
  inline path today fails **silently** leaving the old model (map sharp edge): make it loud, and
  virtual-aware, with a regression test.
- D3: `/thinking` in a routed session reports that route effort owns the value (applies only to
  concrete sessions).
- Sub-agents: an explicit per-state `model` naming a virtual re-enters routing with that
  sub-agent's context at the layering point (`turn-runner.ts:1225-1231`). An omitted state model
  keeps today's inheritance unchanged (synthesis decision — see README).
- Resume: session persists the virtual selection; resume re-classifies (never a stale concrete).

## What the human can run

Plain `duet "<prompt>"` — the daily driver now routes. `/model economy`, `/model gpt-5.6-sol`
(pins), `/model frontier` (resumes routing), one-shot `duet "/model balanced" "…"`. Then: use it
for real work for a couple of days.

## Verification

Extend `test/cli.test.ts`, `test/session-model-switch.test.ts`,
`test/tui-slash-model-command.test.ts`, `test/cli-inline-slash.test.ts`: frontier default boots
without `resolveModelName` ever seeing a virtual; `--provider` unaffected; pin/suspend/resume
state transitions; inline-slash loud failure (regression); virtual state-model resolution with
sub-agent context; resume re-classification; `/thinking` suppression message.

## Must stay green

Full unit suite; `evals/session-resume-history.eval.ts`, `evals/state-machine-agent-model.eval.ts`,
`evals/inline-slash-commands.eval.ts`.

## Human review checkpoint (non-blocking)

None formal at landing — the checkpoint is 2-3 days of dogfood; wrong-route/latency impressions
feed slice 10's closeout tuning (reproduce any misroute in the `duet route` workbench first).

## Feedback that would change this slice

Classifier latency annoying in practice → levers are cadence, hint size, or classifier model in
the table — config edits, not resurfacing this slice.

## Dependencies

Slice 05.
