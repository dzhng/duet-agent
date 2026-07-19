# 03 — Duet client (RPC transport + limits) and telemetry derivation

Local; the highest-value test seam in the bench. Depends on slice 01 for the
final event-shape assertions (details on tool_call steps, complete usage).

## Contract

- `duet-client.ts`: `runDuetTurn(transport: ExecTransport, spec, prompt) →
RolloutOutcome {terminal | "killed", events, timedOut, stepCount,
wallClockMs}`. Speaks the RPC NDJSON protocol (`{"type":"start"}`, prompt,
  parse stream, single terminal). Enforces `RolloutLimits` **from the event
  stream**: step cap counts step events, cost cap reads streaming usage,
  wall clock via injected clock; on breach writes `{"type":"interrupt"}`,
  waits a bounded grace (90 s) for the `interrupted` terminal, then
  `transport.kill()` → `"killed"`. Partial work remains extractable.
- `telemetry.ts`: pure `deriveTelemetry(events: TurnEvent[]) →
{costUsdTotal, costUsdByModel, tokens, advisorCalls (from tool_call steps
with ask_advisor details, split success/rateLimited/unavailable),
routerSwitches (from router_switch events), steps, terminalStatus}` — with
  the actor-vs-memory-model cost split via `usageByModel`.
- `ExecTransport = {stdin, stdoutLines, kill, exited}` injected; production
  transport comes later from `container.execStream` (slice 05). TurnEvent
  types imported from `src/types/protocol.ts`.

## Verification

- Unit, scripted fake transport: happy path; `status:"failed"` surfaced not
  thrown; step-cap breach → interrupt written, `interrupted` accepted;
  cost-cap breach; stalled stream → wall-clock kill (manual clock); stderr
  banner ignored; garbage stdout lines skipped.
- Telemetry unit tests over fixtures: cost sums equal terminal
  `turnUsage.cost.total`; advisor calls counted per outcome; switch histogram
  keys `from→to`; unknown event types tolerated (forward compat). Fixtures:
  one real sanitized economy-tier `--rpc` capture (committed), plus
  hand-built streams containing router_switch and ask_advisor shapes copied
  from `protocol.ts`.
- Live smoke (Mac, cents): real `duet --rpc --incognito --model economy`
  answering a trivial prompt through the client; events parse, cost nonzero.

## Playable checkpoint

`bun benchmarks/swebench/cli.ts rollout local --prompt "What is 2+2?"` prints
the transcript tail and the telemetry summary.
