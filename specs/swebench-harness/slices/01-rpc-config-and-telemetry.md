# 01 — Product: honest RPC configuration and complete telemetry

Pure product work in `src/`; no box, no bench code. Four verified defects
(2026-07-19) would silently invalidate the measurement — and are product bugs
regardless of the benchmark:

1. **RPC ignores project routing tables.** `src/cli/rpc.ts:220` calls
   `buildCliTurnConfig` (built-in table default) while the ordinary CLI path
   uses `buildProjectCliTurnConfig` (`src/cli/run.ts:113`). Result: a
   `.duet/models.json` override — the advisor-OFF arm — does nothing over RPC.
2. **Advisor and classifier spend is unmetered.** `callAdvisor`
   (`src/model-routing/advisor.ts:39`) drops `result.usage`; classifier calls
   likewise never reach `TurnRunner.recordUsage`. Terminal `turnUsage` /
   `usageByModel` undercounts exactly the arm under test.
3. **Tool `details` are dropped from RPC steps.** `agent-events.ts` builds
   `tool_call` steps with input/output/isError but not the tool-result
   `details`, so `ask_advisor` outcomes (success vs `rateLimited` vs
   unavailable) are not structurally distinguishable in the event stream.
4. **RPC can outlive stdin.** The unconditional heartbeat timer keeps the
   process alive after EOF unless a terminal event happened first. Every RPC
   shutdown path must close the writer and stop its timer.

## Contract

- RPC boots from `buildProjectCliTurnConfig` (routing-table discovery walks
  from `--workdir`, same as the CLI).
- Advisor and classifier completions return `Usage` and are recorded via
  the TurnRunner accounting owner with their resolved model ids. Auxiliary
  cost enters the cumulative ledger immediately. The flat usage event is
  emitted only after a real parent context snapshot exists; the first later
  usage event and terminal include every earlier auxiliary call. Invariant:
  Σ `usageByModel[].usage` = terminal `turnUsage`.
- `tool_call` steps carry the tool-result `details` field (typed in
  `src/types/protocol.ts`).
- Closing stdin, fatal startup, normal terminal completion, and disposal all
  stop the heartbeat before flushing the writer.

## Seam

All changes stay inside existing owners: `rpc.ts` (config call site),
`advisor.ts`/`classifier.ts` (surface usage), `turn-runner.ts` (record it),
`agent-events.ts` + `protocol.ts` (wire telemetry). No bench-specific policy
enters `src/`.

## Verification

Complete 2026-07-20. The required focused Docker eval used the custom
`swebench-glm-kimi` table (GLM-5.2 executor, Kimi K3 vision fallback and
advisor) and observed nonzero product-default classifier and Kimi advisor usage
whose per-model sums exactly matched cumulative turn usage.

- Unit: fabricated parent + classifier + advisor usage → exact per-model
  entries and totals, including auxiliary usage recorded before a parent
  completion without fabricating parent context; tool details survive
  translation; EOF terminates RPC.
- Deterministic outer-process RPC check: a project table whose default tier
  exists only in that table boots successfully, reports that tier, then exits
  after stdin closes without waiting for a heartbeat.
- Falsification checks: revert each fix in isolation (built-in table loading,
  dropped auxiliary usage, omitted details, unclosed writer) — the
  matching check must go red.
- Required live smoke (Mac, cents): one forced-advisor turn using the custom
  GLM/Kimi table shows both classifier and advisor spend in cumulative usage.
- `bun run test` stays green; typecheck/lint/format.

## Playable checkpoint

`duet --rpc --workdir <dir-with-override> --model swebench-glm-kimi` shows the
custom table took effect and itemizes every model that ran while leaving memory
on its product default.

## What would change this slice

If a provider stops exposing usage at its completion boundary, stop and
reslice rather than estimating tokens or cost in the benchmark.
