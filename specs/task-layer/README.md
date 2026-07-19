# Task layer — subagents as tool calls, background tasks, quiescent terminals

Everything asynchronous becomes a **task**: tool calls, subagents (new `spawn_agent` tool),
and scheduled waits. Foreground calls race a wait budget (default 120s) then convert to a
"still running" tool result while the work continues — timeout is a nudge, never a kill.
`run_in_background` returns immediately. `task_output`/`task_stop` manage live tasks. The
turn-runner turn ends **only at quiescence**: any in-process task → no terminal (turn open,
VM awake); only wall-clock-scheduled work → `sleep`; nothing → `complete`. **Terminal means
terminal** — over RPC the process is reaped at the first one. `StateMachineController`
dissolves into `TaskManager` + `StateMachineDecisions` + one loop. New `park` state kind;
`ask_user_question` is parent-only. Hard cutover: no compat shims, no migrations (pre-users).

Planning record: `unknowns-map.md` (binding decision ledger + LM-\* landmine cards).
Line refs there are vs 3adf0df; drift as of ddfc6f2 is small but re-verify before pasting.

## Next Agent Prompt

**Status:** slices 01-13 merged. TUI task tree live: pure projection, task lanes,
held-awake status, late attach from hydrated state; unprimed critique passed after the
fixture gained the parent-narration path (renderer emits "● parent — <activity>").
**Slice 14 in progress:** stabilize the two straggler RPC evals (lost-resume, heartbeat —
model-compliance variance; being made mechanical), verify falsification records in every
task-layer eval, then the full shipping gate (check-types/lint/format/test/eval) and
ledger-decision reconciliation before close-spec. Last updated 2026-07-19.

You are implementing this spec. Read this README fully, then `unknowns-map.md` Quadrant 2
(binding decisions — do not relitigate) and the LM-\* cards for your slice. Work one slice at
a time from `slices/`, in dependency order. **Pickup point: run slice 11's Docker gates, then 12, 13, and 14.**

Per pass: follow [implement-spec](../../.claude/skills/implement-spec/SKILL.md) discipline —
implement, verify the slice's gate (red/green; live evals per
[write-eval](../../.claude/skills/write-eval/SKILL.md) with falsification), run
/code-review on the diff, commit, then update this section (status, pickup point, checklist)
before ending your pass. Workflow: Opus subagents implement, main agent reviews.

**Blockers/warnings:** this worktree cannot access the Docker socket and has no eval credential;
slice 11's `task-memory-synthetic-filter.eval.ts` and Docker source-of-truth suite remain to run.

**Global TODO**

- [x] 01 pi-contract spike (verdict gate) — CONFIRMED ×5, committed 5baec9a
- [x] 02 clock + verification kit — merged 06f23fc
- [x] 03 TaskManager kernel + quiescence decider — merged d26b7bd
- [x] 04 task protocol + durable snapshot contract — merged e378959
- [x] 05 subagent executor extraction — merged 634294e
- [x] 06 StateMachineDecisions extraction — merged 63260d4
- [x] 07 the cutover: one loop, controller deleted — merged (post-review fixes included)
- [x] 08 async surface — merged 82f31e4; 7/7 live evals green
- [x] 09 spawn_agent — merged; live evals green
- [x] 10 park + parent-only ask — merged; 3/3 live evals green incl. promised-wait
- [x] 11 observer/router/compaction hygiene — merged 8d5b7e6
- [x] 12 session/RPC durability — merged (two live evals red → slice 14)
- [x] 13 TUI task tree — merged + fixture fixup 6630e13
- [ ] 14 live-eval acceptance matrix (done-gate)

## Slice graph

```
01 pi-contract spike ─► 02 clock/fixtures ─► 03 TaskManager ─► 04 protocol
04 ─► 07 cutover ◄─ 05 subagent executor ◄─┐(05, 06 are behavior-preserving
07 ─► 08 async surface ─► 09 spawn_agent    │ extractions; parallel after 01)
07 ─► 10 park + ask       06 decisions ◄────┘
08 ─► 11 hygiene          08 ─► 12 session/RPC ─► 13 TUI
{09,10,11,12,13} ─► 14 eval matrix
```

01–06 are preparation: 01/02 prove mechanics and build test seams; 03/04 add the new
libraries; 05/06 are behavior-preserving extractions that shrink 07. 07 is the pivot —
controller deleted, existing suite green **unmodified**. 08 ships the feature on bash;
09–13 extend it; 14 closes the done-gate.

## Module graph — one owner per concept

```
src/tasks/                    NEW, zero-dependency library (no pi, no app imports)
  task-manager.ts             task lifecycle, budget race, settlement FIFO, scopes, buffers
  quiescence.ts               computePendingWork() — the ONLY code that decides a terminal kind
  types.ts                    TaskId, TaskDescriptor, TaskSettlement — the ONE task shape
                              (protocol, persistence, TUI all reuse it; no mirror types)
src/turn-runner/
  runtime-clock.ts            NEW — the one owner of Date.now/setTimeout for task+schedule paths
  subagent.ts                 NEW — SubagentSpec + createSubagentExecutor; the ONLY way any
                              subagent is constructed (agent states + spawn_agent = spec builders)
  state-machine-decisions.ts  NEW — pure ledger/planner over state-machine-session.ts helpers
  task-tools.ts               NEW — spawn_agent, task_output, task_stop, budget wrapper; the one
                              formatter each for "still running" / settlement wordings
  turn-runner.ts              the one loop, parent-slot queue, control-capture asserting queue,
                              single-exit terminal emission, interrupt; only module that
                              constructs Agents and emits TurnEvents
  state-machine-controller.ts DELETED in slice 07 (no facade, no re-export shim)
  shell-state-handle.ts       shell exec + process-group kill template (reaper reuses it)
```

Import firewall: `src/tasks/*` imports nothing from the app or pi. `subagent.ts` may import
classifier/resolve but never the `ModelRouter` class. `state-machine-decisions.ts` never
imports TaskManager, Agent, or executors. `session/*` and `tui/*` see tasks only through
protocol types/events. Only `quiescence.ts` decides terminals; only the loop's single exit
emits them; only TaskManager settles tasks; only `runtime-clock.ts` touches wall time on
task/schedule paths.

## Invariants (the end state must read as designed today)

1. **Terminal ⇒ quiescent ⇒ reapable.** One terminal per turn, emitted at one exit, inside a
   try/finally (a thrown turn still terminates — today `Session.dispatchTurn` hangs waiters).
2. **No hard kill.** Only `task_stop`, interrupt, or scope close abort work. Interrupt
   escalates SIGTERM → SIGKILL after a grace period so the `interrupted` terminal is never
   blocked by a stubborn child.
3. **Settlements live only in TaskManager's pull FIFO.** Never in pi's steer/followUp queues
   (they revive terminated runs — confirmed agent-loop.js:154/157). Delivery = loop-owned
   re-prompt passes, batched; mid-run steer is best-effort and gated on no captured control
   result. Internal passes assert pi queues empty at start and are marked continuations
   (router `noteTurnStart` must not fire).
4. **Control tools are sequential and asserted.** `ask_user_question`,
   `select_state_machine_state`, `create_state_machine_definition` get
   `executionMode: "sequential"`; control capture is an asserting queue, never
   last-writer-wins. **Admin lane:** control tools and `task_output`/`task_stop` are pi tool
   calls but never create task descriptors (self-observation hazard).
5. **One subagent constructor, one task shape, one wording source.** SubagentSpec is the
   internal superset; the public spawn_agent schema is a restricted builder (no model/
   system_prompt in v1).
6. **Structured concurrency.** Every task has an owner scope; scope close cascade-stops
   descendants (children incl. memory scratch). Depth 2; descope valve = config clamp to 1.
7. **Test knobs don't ship.** Clock injection, floor overrides, short budgets are
   dependency-injected; a test asserts production defaults (120s budget, 15-min floor) intact.
8. **Vendored pi is read-only**; slice 01's contract tests double as an upgrade tripwire.
   Stay on 0.79.10 (ledger #14). Guardrails firewall stays dead (LM-G1 deferred).

## Standing verification gates

- Every slice: `bun run check-types && bun run lint && bun run test`; live evals
  docker-gated per repo convention. New evals follow write-eval red/green **plus a recorded
  falsification** (break the behavior, prove red, restore).
- Slice 13 (TUI) has a visual surface: run an unprimed
  [screenshot-critique](../../.claude/skills/screenshot-critique/SKILL.md) as the last check
  on its shots before acceptance.
- "Turn completed" alone is never an acceptance assertion — combine event order, task ids,
  sentinels, and negative assertions (fallback routes closed).

## Open items / product calls recorded

- **Bash children get SIGKILL on stop in v1** (decided at slice 08): pi's bash abort handler
  kills the process group immediately; the wrapper cannot TERM-first without pi's tracked-pid
  registry. Liveness (invariant 2's purpose) holds; graceful TERM-first for bash children is
  deferred to slice 12's shutdown work. Script states and subagents stop gracefully.

- Ledger #15 OPEN: does spawn_agent eventually subsume state-machine agent states?
- Task settlements remain deliberately absent from the editable follow-up panel. They bypass
  pi's follow-up queue by invariant, and the read-only task tree is their visible surface;
  showing them beside poppable prompts would falsely imply that Ctrl+C can edit delivery.
- Heartbeat events are droppable/coalescing under backpressure; task + terminal events are
  lossless and ordered (slice 12).
