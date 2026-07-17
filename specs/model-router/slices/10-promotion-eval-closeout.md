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
