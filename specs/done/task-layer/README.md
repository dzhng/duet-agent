# Task layer — subagents as tool calls, background tasks, quiescent terminals

Shipped 2026-07-19. Everything asynchronous in the runner is a **task**: tool executions,
subagents (`spawn_agent`), and scheduled waits. A foreground tool call races a wait budget
(default 120s, `timeout` param overrides) and converts to a "still running" result while the
work continues — timeouts nudge, they never kill. `run_in_background` returns immediately;
`task_output`/`task_stop` manage live tasks. The turn ends only at quiescence: in-process
work holds it open, wall-clock-scheduled work sleeps it, an empty set completes it. The
former `StateMachineController` is gone; state machines run on the same task rails, plus a
`park` state kind (machine holds position, the parent drives) and parent-only
`ask_user_question`.

Planning provenance: `unknowns-map.md` (the quadrant-walk record: binding decision ledger,
landmine cards, the two architecture spikes). `assets/transcript-fragments.md` holds the
accepted user-facing wordings (B1–B4), the public `spawn_agent` schema, and the TUI
task-tree sketch — these were the standard the surfaces were built and judged against; the
frame fixture `test/fixtures/tui/task-tree-active-frame.txt` pins the realized tree against
that sketch.

## Why this shape

- **The vendored pi loop's contract is load-bearing, not an obstacle.** pi-agent-core
  requires every tool call to return a result before the next model call. The task layer
  never fights this: "async" lives in results that say _still running_ while a
  runner-owned `TaskManager` keeps the work. `test/pi-loop-contract.test.ts` pins the five
  vendored behaviors the design leans on (steer/followUp revive terminated runs; one
  sequential tool serializes a batch; early tool resolution detaches cleanly) and doubles
  as the tripwire for any future pi upgrade.
- **Terminal means terminal** because duet runs over RPC in cloud sandboxes that reap the
  process at the first terminal event. Every terminal is therefore a promise of
  quiescence, produced at a single try/finally exit from one pending-work decider. This
  invariant, not elegance, forced the single-loop architecture.
- **Settlements never touch pi's steer/followUp queues.** A queued message revives a
  terminated pi run (pinned in the contract tests), so settlement delivery lives in the
  TaskManager's pull FIFO and the loop delivers it as re-prompt passes. Mid-run steer is
  best-effort only, gated on no captured control result.
- **One subagent constructor.** State-machine agent states and `spawn_agent` are two thin
  spec builders over `createSubagentExecutor` — forkContext, skills, identity layer, model
  resolution and usage tagging exist once. The public spawn schema is deliberately
  restricted (no `model`/`system_prompt`); `SubagentSpec` is the internal superset.
- **Child model + memory inherit by policy, not by tool params:** a concrete parent model
  setting inherits verbatim; a virtual setting classifies the child prompt once via the
  stateless `classifySpawnModel` seam — never the shared `ModelRouter`, which is
  non-reentrant by design. Child memory is `parent:sub:<taskId>` with a per-child wire
  horizon, observed only under compaction pressure, dropped at scope close.

## Invariants the code must keep honoring

1. **Terminal ⇒ quiescent ⇒ reapable.** One terminal per turn from the single exit in
   `runTurnLoop`; a thrown pass still terminates; open work at exit is force-stopped and
   the turn fails rather than lie. `computePendingWork` (`src/tasks/quiescence.ts`) is the
   only code that decides a terminal kind.
2. **No kill by timeout; uniform SIGKILL on stop.** Only `task_stop`, interrupt, or scope
   close abort work, and stopped process groups die by immediate SIGKILL across every
   executor. No TERM-grace window exists on any task path (see Dead ends). One
   non-task exception: skill `$(...)` shell expansion during prompt preprocessing uses
   `execFileSync` with a 30s SIGTERM timeout (`src/turn-runner/skills.ts`) — outside the
   task layer's stop semantics.
3. **Control tools are sequential and asserted** (`ask_user_question`,
   `select_state_machine_state`, `create_state_machine_definition`); control capture
   throws on a second control result per pass. Admin tools (`task_output`, `task_stop`)
   never create task descriptors.
4. **The ask gate:** an `ask` terminal may only be emitted when no in-process task exists;
   an ask under open work is stashed and its questions resurface as a one-shot reminder
   (`withheldAskReminder`, via `prepareParentPassInput`) on whichever parent pass runs
   next — mirroring the state-machine re-prompt pattern.
5. **Structured concurrency:** every task has an owner scope; scope close cascade-stops
   descendants (including the child's `:sub:` memory scratch); depth 2 is enforced in the
   kernel.
6. **`<system-reminder>` is the one harness tag.** Every machine injection is a single
   (nesting-safe) reminder block, and observer + step-trigger projections strip reminder
   segments from any role (`src/lib/system-reminder.ts`) — the memory system must never
   record plumbing as user statements. (The earlier `<duet-synthetic-user-message>`
   sentinel was deleted by user decision at the choices audit.)
7. **Internal re-prompt passes are continuations:** they skip `ModelRouter.noteTurnStart`
   and the memory observer; the observer runs once per real turn at quiescence plus under
   compaction pressure.
8. **RPC processes exit at their terminal regardless of host stdin** — the driver destroys
   the stdin reader at chain completion. Task and terminal events are lossless and
   ordered on the wire; heartbeats are a droppable, coalescing lane emitted
   unconditionally from RPC start to terminal — silence past the interval always means a
   wedged process.
9. **Test knobs don't ship:** clock injection and the scheduling floor are
   constructor-level dependencies (`TurnRunnerDependencies`), not config; the wait budget
   is deliberately public config (`taskWaitBudgetMs`) with a per-call `timeout` override.
   `test/runtime-clock.test.ts` pins all three production defaults.
10. **Vendored pi is read-only** and pinned to 0.79.x; the contract tests gate any bump.

## Pointers into the code

- Kernel: `src/tasks/task-manager.ts` (settlement FIFO, finished-barriers, `ScopeId`-typed
  scopes,
  budget race, `recover`→lost), `src/tasks/quiescence.ts`, `src/tasks/types.ts` (the one
  task shape reused by protocol, persistence, TUI). Tests: `test/task-manager.test.ts`,
  `test/quiescence.test.ts`.
- The loop: `TurnRunner.runTurnLoop` in `src/turn-runner/turn-runner.ts` (parent-slot
  queue via `ParentLoopInput`, settlement batching, ask gate, interrupt emitting its own
  terminal, `discardStaleTaskSettlements`). Seam tests: `test/turn-runner-cutover.test.ts`
  (including the one-transition-pass-per-completion pin), `test/turn-runner-async-surface.test.ts`.
- Tools & wordings: `src/turn-runner/task-tools.ts` (`wrapBackgroundable`, `spawn_agent`,
  admin tools, and the single builder per user-facing wording — other code imports the
  builders, never copies strings).
- Subagents: `src/turn-runner/subagent.ts` (`SubagentSpec`, `createSubagentExecutor`,
  `classifySpawnModel`).
- State machines: `src/turn-runner/state-machine-decisions.ts` (execution-free
  planner/ledger over
  `state-machine-session.ts`; park included), prompts in `src/turn-runner/prompts.ts`
  (`parkNudge`, `heldAskReminder`). The one filesystem touch in the planner is spilling
  oversized state output to overflow files.
- Time: `src/turn-runner/runtime-clock.ts` — the one owner of wall time on task/schedule
  paths; `ManualRuntimeClock` in `test/helpers/`.
- Durability & transport: `src/session/session.ts` (atomic coalescing writer, hydrate
  reconciliation), `src/cli/rpc.ts` (heartbeats, stdin teardown at terminal,
  `shouldEmitFatalTerminal`).
- TUI: `src/tui/task-tree.ts` (pure projection), `task-lane-renderer.ts`;
  fixture `test/fixtures/tui/task-tree-active-frame.txt` vs the accepted sketch in
  `assets/transcript-fragments.md`.
- Live evals (each records its falsification in-file): `evals/task-*.eval.ts`,
  `evals/state-machine-park.eval.ts`, `evals/spawn-scoped-memory.eval.ts`,
  `evals/bash-timeout.eval.ts` (pins the no-kill contract).

## Divergences from the plan

- **TERM-grace escalation was built, then deleted.** The plan's invariant 2 specified
  SIGTERM → grace → SIGKILL. pi's bash abort SIGKILLs immediately and owns the child PID,
  so the guarantee only ever held for script states. Rather than keep a two-faced
  contract, stop semantics were unified on immediate SIGKILL (user decision at slice 14);
  `escalateStop`, the grace race, and `forceKill` were deleted. Graceful TERM is a future
  explicit opt-in if ever needed.
- **The ask gate shipped in the cutover, not slice 08** — an independent review showed a
  steered parent could ask mid-state-work and emit an `ask` terminal over live tasks.
- **Slice 14 found two product bugs the plan didn't predict:** transition enforcement
  treated a valid selection that starts async work as "no selection" and retried
  (re-selecting/re-running states — order corruption and doubled passes across every
  state-machine flow); and RPC processes outlived their terminal whenever the host kept
  stdin open (a pending stdin read blocks generator finalization). Both are pinned by
  regression tests.
- `TaskManager.nextSettled()` is a synchronous poll (paired with `waitForSettlement`),
  not the planned promise — the loop composes the two.
- `TurnState.queuedCommands` survives as a persisted projection of pending user inputs
  (resume/serialization contracts observe it); execution ownership moved to the
  parent-slot queue as planned.
- Pending settlements are deliberately absent from the editable follow-up panel — the
  read-only task tree owns that visibility; mixing them into a Ctrl+C-poppable list would
  imply editability they don't have.
- Ledger #15 remains open by design: whether `spawn_agent` eventually subsumes
  state-machine agent states.

## Dead ends

- **"Controller as TaskManager client"** — spiked head-to-head against dissolution and
  refuted by its own spike: it needs a hand-rolled settlement `claim()` ownership
  protocol, dual notification paths, and shadow state — a controller that still knows its
  server's choreography. Recorded in `unknowns-map.md`.
- **Delivering settlements via pi steer/followUp** — rejected before build; the contract
  tests proved queued messages revive terminated runs.
- **The synthetic sentinel as a model-behavior suspect** — when state-transition order
  regressed, the visible `<duet-synthetic-user-message>` tags were A/B-tested as the
  cause (markers disabled, eval still failed) and exonerated; the real culprit was the
  enforcement retry bug. Worth remembering before blaming prompt markup for behavior
  shifts.
- **Asserting SIGTERM markers in process fixtures** — unprovable under SIGKILL semantics;
  the evals assert liveness (PID gone + task settled) instead.
- **Probing PGlite through a second connection** — one live instance per data dir; eval
  probes must go through the runner's own session or they read stale state
  (`evals/spawn-scoped-memory.eval.ts` shows the pattern).

## Verification record

Shipping gate on the final tree: full docker suite 1134 pass / 0 fail; full eval matrix
180 pass / 11 fail with all 11 failures reproducing identically on the pre-task-layer
baseline (78ee853) — `memory-reflect`, `recall-memory-implicit-triggers`,
`openai-thinking-traces`, `model-direct` (nano-banana case), and the known-flaky
`model-routing-mixed-task` promotion; none task-layer. Eval credentials come from the repo-root `.env` (AI gateway key),
forwarded into the docker eval invocations.
