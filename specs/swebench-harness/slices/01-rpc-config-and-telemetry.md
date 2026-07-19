# 01 — Product: honest RPC configuration and complete telemetry

Pure product work in `src/`; no box, no bench code. Three verified defects
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

## Contract

- RPC boots from `buildProjectCliTurnConfig` (routing-table discovery walks
  from `--workdir`, same as the CLI).
- Advisor and classifier completions return `Usage` and are recorded via
  `recordUsage` with their resolved model ids; invariant preserved:
  Σ `usageByModel[].usage` = terminal `turnUsage`.
- `tool_call` steps carry the tool-result `details` field (typed in
  `src/types/protocol.ts`); no new event types.

## Seam

All changes stay inside existing owners: `rpc.ts` (config call site),
`advisor.ts`/`classifier.ts` (return usage), `turn-runner.ts` (record it),
`agent-events.ts` + `protocol.ts` (details on the step). No bench-specific
policy enters `src/`.

## Verification

- Unit: fabricated parent + classifier + advisor + memory usage → exact
  per-model entries and totals; a scripted RPC session with two tables
  differing only at `tiers.balanced.advisor.enabled` shows ON exposes
  `ask_advisor` (details preserved) and OFF omits the tool entirely.
- Falsification checks: revert each fix in isolation (drop table loading,
  drop advisor usage, drop details) — the matching test must go red.
- Live smoke (Mac, cents): one forced-advisor turn on economy tier shows
  advisor cost present in `usageByModel`.
- `bun run test` stays green; typecheck/lint/format.

## Playable checkpoint

`duet --rpc --workdir <dir-with-override>` against a test override prints a
banner turn whose events show the overridden table took effect and whose
terminal usage itemizes every model that ran.

## What would change this slice

If classifier/advisor metering requires a pi-ai seam change (usage not
exposed through the AI SDK path), stop and reslice — that becomes a pinned
package decision, not a workaround in this slice.
