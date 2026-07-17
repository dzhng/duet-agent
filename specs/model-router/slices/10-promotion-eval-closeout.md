# 10 — Mixed-task promotion eval + closeout tuning

## Contract unlocked

The feature meets the map's definition of done: eval-covered end-to-end, with judgment-call
defaults revisited against real evidence and the tuning workflow documented for the future.

## API seam

`evals/model-routing-mixed-task.eval.ts` — docker-gated, production-path (`EVAL_MODEL` unset for
the acceptance run so the real luna classifier + built-in table are exercised; default 5-step
cadence — accelerated cadence allowed for local iteration only, never promotion). One long
coding task that genuinely crosses phases: frontend/visual implementation → backend/API work.
Captured via `CapturingRunner` + event subscription.

Assertions: visual phase routes to kimi-k3 (high); backend implement phase routes to gpt-5.6-sol
(high); at least one switch occurs intra-turn; switch order matches the task transition; usage
attributed to both concrete ids and sums to the total; no switch/nudge loop; terminal state
valid; classifier/advisor actors never recursively route.

**Falsification:** swap the visual/implement route descriptions → eval fails.

## Closeout tuning

Re-validate or re-tune the numeric defaults against dogfood + eval evidence: 5-step cadence,
1-per-5 advisor floor, 10k transcript budget. Write final values into the built-in table and the
map's ledger. Harvest dogfood misroutes into the golden corpus (slice 04's eval ratchets as the
regression floor).

## Closeout audit (refactor-clean sweep before calling it shipped)

- Stale comments claiming the parent model is fixed per session (`turn-runner.ts:2020-2022`
  neighborhood).
- Old concrete-default assumptions; any direct virtual name reaching `resolveModelName`.
- Redundant guards made dead by routing guarantees; duplicate prompt literals outside
  `prompts.ts`; persisted transient concrete routes; usage attribution via live agent state.
- Then run the repo's `/review` closeout (refactor-clean → code-review → write-docs) and
  `close-spec` to archive this plan.

## What the human can run

`bun run check-types && bun run lint && bun run format:check && bun run test && bun run eval` —
all green. Plus: a normal day of work on the routed default.

## Must stay green

Everything — this is the promotion gate.

## Human review checkpoint (non-blocking)

The feature's exit interview: mixed-task route timeline, advisor trace, final defaults summary,
prompt scorecards. ~5-minute window, then promote on evidence and record.

## Dependencies

Slices 07 + 09.

## Promotion evidence

Production acceptance ran with `EVAL_MODEL` unset, `DUET_API_KEY` blank, the real built-in
`frontier` table, the real Luna classifier, and the default five-step cadence.

- Passing switch timeline: `turn_start: general/sol → visual/kimi-k3 (high)`, then
  `cadence: visual/kimi-k3 → implement/gpt-5.6-sol (high)`. All visual tool calls preceded the
  backend phase; the final backend read/edit/test calls ran on Sol. Two switches stayed below the
  eval's four-switch loop bound.
- Passing final-run usage: `moonshotai/kimi-k3` 63,619 tokens / $0.02870906;
  `openai/gpt-5.6-sol` 32,949 tokens / $0.00 provider-reported cost; 96,568 tokens /
  $0.02870906 total. Both per-model token sums and cost sums matched the turn aggregate. Luna did
  not appear in this run because the in-memory observer made no billable call; the eval permits it
  only as the memory actor and rejects Luna or Fable as routed parent models.
- Falsification: temporarily swapped the frontier visual and implement route descriptions. The
  run inverted the routes (`turn_start → implement/sol`, `cadence → visual/kimi`) and failed at the
  visual-on-Kimi assertion. Restoring the descriptions returned the eval to green.
- Live runs: 4 total (one over-strict Luna-usage assertion failure, one passing acceptance, one
  expected-red falsification, one passing post-restore confirmation). Provider-reported spend was
  approximately $0.1233 across all four runs.
- Numeric defaults: unchanged. The five-step cadence caught the phase transition with room for
  multiple Sol backend steps and no switch/nudge loop. This eval produced no contrary evidence for
  the existing one-per-five advisor floor or 10,000-token advisor transcript budget.

## Decision reconciliation (orchestrator, 2026-07-18)

Every recorded decision checked against shipped code, per implement-spec's closeout rule:

- Ledger rows 0-10, D1-D3 (unknowns-map Quadrant 2): all implemented — economy vision fallback
  via `implement-visual`/visionRoute; single classifier call with schema-constrained routes;
  cache preference in the classifier prompt with prev-turn hint; step-based advisor floor with
  cap-exempt nudge (one-shot, loop-guarded); pinned+observations+tail transcript at uniform 10k;
  optional complete-replacement config + `duet config export`; collision-before-canonicalize;
  two-layer display + `router_switch` + `/route` + pin semantics; exemptions (memory actor,
  classifier, advisor, explicit concrete state models) with virtual state models via
  resolveTierDefault; advisor on the shared AI SDK gateway (credential fallback owned by
  createDuetModelGateway); usage keyed on per-message concrete ids; router effort wins with
  `/thinking` suppressed in routed sessions.
- Quadrant 3 extracted decisions: interlock both ways (nudge on switch, classifier check on
  consult) — shipped; always-on frontier default — shipped; evals-as-done — three live evals
  (classifier scorecard, advisor-trigger, mixed-task promotion) all green with falsification.
- Landmines L1-L7: all discharged (L2 live context getter, L3 virtual pre-check before
  canonicalize/provider-pin, L4 vision guard in resolve.ts, L5 no-throw hook + threaded signal,
  L6 origin-filtered step counter, L7 live observation read).
- OPEN items: kimi effort delivery — closed with wire evidence (high→max mapping);
  classifier latency ceiling — measured, frozen, then recalibrated to a sanity bound with
  recorded provider-variance evidence (slice 04).
- Intra-turn rerouting (originally "phase 2 optional", upgraded during planning): shipped in
  phase 1 and proven by the promotion eval's cadence-triggered mid-turn switch.
- No decision remains unimplemented; nothing required a "no code needed" marker except the
  deferred `duet route advisor-preview --session` history reconstruction caveat recorded in
  slice 08 (preview uses current-cwd composition — accepted).
