# 09 — Interlock (reroute nudge) + advisor prompt tuning + advisor evals

## Contract unlocked

Router and advisor become one system, safely: a real route change injects one cap-exempt,
one-shot nudge to consider `ask_advisor`; advisor consults trigger reclassification (wired in 05/08);
no loops. The advisor-facing prose is tuned against live evals.

## API seam

- `prompts.ts`: `renderRerouteNudge(switch)` + the executor-side timing/advice-weight blocks
  (adapted from Anthropic's published executor prompts). The runner injects
  `router.takeRerouteNudge()` output through the existing steering/follow-up mechanism — never by
  rebuilding the cached system prompt.
- Interlock invariants (all enforced in `ModelRouter`, slice 05 API): nudge emitted only on an
  actual change; consumed at most once; the nudge-driven consult bypasses the step floor exactly
  once; failed/refused advisor calls do NOT trigger reclassification; trigger tags
  (`turn_start|cadence|advisor`) prevent loops.

## Evals

`evals/advisor-trigger.eval.ts` (docker-gated, `EVAL_MODEL`, `tool_call_start` subscription
precedent from `evals/state-machine-routing.eval.ts`):

- Challenging underspecified task → `ask_advisor` fires, advice non-empty, a classifier check
  follows with trigger `"advisor"`, first call not wrongly suppressed by the floor.
- Routine/local task → advisor NOT called (restraint case).
- Advisor-disabled tier → tool absent.
- Nudge case: a forced reroute → nudge-driven consult bypasses a closed gate exactly once.
- **Falsification:** remove the trigger guidance from the tool description → positive case fails;
  break the one-shot guard → the loop/cap assertion fails.

Optional scope (add only if dogfood advice feels weak): an advice-quality eval running curated
transcripts through the real advisor and grading against a rubric (identifies the hidden
uncertainty, concrete next check, respects executor ownership).

## Tuning pass (scope firewall)

May edit only: advisor tool description, advisor system prompt, nudge text, executor-side
advice-weight block — all in `prompts.ts`. Classifier scorecard (slice 04) must stay green after
every change. Tuning provenance recorded here (before/after eval outcomes).

## What the human can run

A frontier session with a forced reroute showing the nudge → consult → advice → reclassify
chain; `bun test evals/advisor-trigger.eval.ts` in docker.

## Must stay green

Slices 05/08 suites, classifier scorecard, full unit floor.

## Human review checkpoint (non-blocking)

Sample nudge text + 2 advisor exchanges post-tuning; ~5-minute window, decide on evidence,
record.

## Dependencies

Slices 06 (routed daily surface) + 08.
