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

Resolution (2026-07-18): accepted on evidence. The shipped nudge is: “The routed model changed
from X to Y for the Z route. If the new work would benefit from strategic review, consider
calling ask_advisor before substantive work. This consult is cap-exempt.” Two independent live
advisor samples both found the hidden contradiction between exactly-once external side effects
and unmodified opaque plugins, recommended validating a single runner-owned side-effect
interception/fencing boundary first, and preserved executor ownership by ending with a concrete
validation rather than attempting implementation. The first additionally proposed a reversible
dual-write/record-only slice; the second stayed narrower and asked for an audit of plugin-call
mediation. Both were direct, actionable, and within scope, so no `ADVISOR_SYSTEM_PROMPT` change
was justified.

## Tuning log

- Baseline with the slice-08 `ASK_ADVISOR_TOOL_DESCRIPTION`: the live architectural case called
  `ask_advisor` once, returned non-empty advice, and caused a classifier input tagged `advisor`;
  the routine rename case made zero advisor calls. The new nudge wording was kept to two short
  sentences plus the explicit cap exemption because the deterministic runner case delivered and
  acted on it without another prompt surface.
- First falsification attempt removed the timing paragraph but remained green. The eval's own
  system text mentioned “tools made available,” which independently primed tool use, so that run
  did not prove the production description mattered.
- Calibration removed that eval-only tool hint while keeping the production timing paragraph
  absent. The same architectural case then failed as intended with zero `ask_advisor` calls.
  Restoring only the timing paragraph returned the calibrated case to green; the full suite then
  passed 4/4. This is the before/after evidence that the timing guidance is load-bearing.
- One-shot falsification first removed the consume-time burn and stayed green because
  `noteAdvisorConsult()` defensively burns stale privilege after success. Removing both burns made
  the second fake consult succeed and failed the rate-limit assertion; restoring both returned the
  NUDGE case to green. Failed and refused calls remain outside `noteAdvisorConsult()`, so neither
  schedules advisor-triggered classification.
- Later acceptance runs exposed positive-case misses with both the original broad timing paragraph
  and a non-normative list of the intended boundary (the other three cases stayed green). The final
  wording makes that boundary explicit and normative: consequential architecture, conflicting
  constraints, and important unknowns must consult, while routine, local, obvious work must not.
  The next live positive/restraint run passed 2/2 and the deterministic pair remained green.
- The classifier scorecard remained 28/28 accurate with every family at 100% and 567 maximum input
  tokens. One post-nudge run passed the frozen latency ceiling at p50 1595 ms; two later runs after
  advisor-only wording changes kept correctness perfect but missed only the latency ceiling at p50
  2193/2743 ms through the Vercel fallback. No classifier text, route description, fixture, or
  numeric gate changed in this slice.

## Dependencies

Slices 06 (routed daily surface) + 08.
