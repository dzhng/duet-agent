# Task layer & subagents-as-tools — unknowns map

Quadrant walk completed 2026-07-18 (David + Claude). This map is the planning deliverable;
implementation starts from it. Line refs are against `main` @ 3adf0df.

The feature: everything asynchronous becomes a **task** — tool calls, subagents, scheduled
waits. Foreground calls race a wait budget then convert to "still running" (timeout = nudge,
not kill). `run_in_background` returns immediately. Subagents are tool calls, parallel via the
existing batch parallelism. The turn-runner turn ends only at quiescence, because **terminal
means terminal** (over RPC the process is reaped at the first terminal). The
StateMachineController dissolves into `TaskManager` + `StateMachineDecisions` + one loop.

---

## Quadrant 1 — Known knowns (settled ground)

- The model→tool loop is vendored (`@earendil-works/pi-agent-core` 0.79.10): every tool call
  returns a result before the next model call; batched calls already run in parallel
  (`toolExecution: "parallel"`, turn-runner.ts:2138; `Promise.all`, agent-loop.js:332).
  We build the task layer _around_ this contract, not by forking it.
- Subagents exist behind the state machine only: `createStateAgentHandle` (turn-runner.ts:1245)
  — forkContext, per-child model/skills/cwd, event origin tagging, single-slot.
- Full param surface of an agent state (state-machine.ts:264-335): `prompt`, `systemPrompt`,
  `allowedSkills`, `cwd`, `model`, `thinkingLevel`, `forkContext` (+ base `name`/`when`/
  `inputSchema`). This is the spawn tool's surface too — one shared `SubagentSpec`.
- Terminals: `ask | complete | interrupted | sleep` (protocol.ts:818-822). Sleep →
  `Session.scheduleWake` wall-clock polling (session.ts:589). Nothing external owns process
  lifetime.
- Nudge machinery that exists and is reused: `agent.steer()` injection (router nudge,
  turn-runner.ts:2634), durable follow-up queue, sleep/wake, terminal-ack re-prompt flow.
- Upstream probe: **no pi version (through 0.80.10) has background tools, a task manager, or a
  subagent API.** Ingredients only: steer/followUp queues, `agent_settled`/`waitForIdle` (0.80),
  cache-friendly dynamic tool loading (`addedToolNames`, 0.80.7), and a subprocess subagent
  _example_ (blocks the parent; max 8 tasks / 4 concurrent; markdown agent defs) at
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`.
- Reusable seam: `routerStepObservation` (turn-runner.ts:2641) — pi `turn_end` → pi-free
  `StepObservation`; same shape works for task-completion observation.
- Claude Code precedent (the inspiration): everything is a task; `TaskOutput`/`TaskStop`/
  `TaskList`; `run_in_background` on Bash and Agent; `<task-notification>` re-invocations;
  tool calls still always return results — "async" lives in the task layer, not the protocol.

## Quadrant 2 — Known unknowns (decision ledger)

| #   | Question                        | Decision                                                                                                                                                                                                                                                                                     | Closed by                     |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | Unification shape               | **Dissolve the controller**: `TaskManager` (execution) + `StateMachineDecisions` (ledger/planner) + one loop in TurnRunner. Both architectures were spiked in parallel; the "controller as client" spike refuted itself (claim() ownership protocol, dual notification paths, shadow state). | User + spikes                 |
| 2   | Migration                       | **None** — direct build, no façade/stages; nobody uses this yet. Full test/eval coverage is the parachute.                                                                                                                                                                                   | User                          |
| 3   | Terminal rule                   | Parent run ends → one decider checks the task set: any in-process task → **no terminal, turn stays open** (VM awake); only scheduled (wakeAt) work → `sleep`; empty → `complete`. Terminal is a hard promise of quiescence.                                                                  | User                          |
| 4   | Parent-idle semantics           | Parent pi-run may end while tasks run (like state-machine states today). Settlements re-prompt the parent within the open turn; user prompts follow existing steer/follow-up handling.                                                                                                       | User                          |
| 5   | Interrupt                       | Kills **everything** (foreground, background, subagents, scheduled) and emits the `interrupted` terminal itself.                                                                                                                                                                             | User                          |
| 6   | Ask                             | `ask_user_question` is **parent-only**, everywhere. State-agent ask machinery is removed.                                                                                                                                                                                                    | User                          |
| 7   | Park state                      | New state kind `park`: no execution, no task; machine holds position while the parent drives. End-of-every-turn nudge: "machine parked at X; if the park's purpose is fulfilled, select the next state."                                                                                     | User                          |
| 8   | Child model                     | Inherit the parent's model **setting**: concrete → same concrete; virtual → one classifier call on the child's prompt at spawn (NOT via the shared ModelRouter instance — see LM-R2).                                                                                                        | User                          |
| 9   | Recursion                       | Depth 2 (one layer). **Full powers + structured concurrency**: tasks record an owner scope; scope close cascade-stops its tasks. Descope valve if buggy in practice.                                                                                                                         | User                          |
| 10  | Child memory                    | **Lazy scoped observation**: per-child `parent:sub:<taskId>` memory session + per-child horizon; no routine child observer; observation fires only via compaction pressure (`ensureMemoryCoverageForCompaction`); child scratch dropped at scope close.                                      | User (simplest-that-compacts) |
| 11  | Parent observer cadence         | Quiescence + pressure — once per real turn, never per settlement re-prompt.                                                                                                                                                                                                                  | User (via #10 discussion)     |
| 12  | Wait budget                     | 120s default; `timeout` param = per-call budget; config knob; **no hard kill anywhere** (only task_stop / interrupt / scope close).                                                                                                                                                          | Recommendation, unvetoed      |
| 13  | Task tool surface               | `task_output(id?, {wait?})` (no id = list; wait blocks up to N for settlement), `task_stop(id)`; `run_in_background` on `bash` + `spawn_agent` in v1.                                                                                                                                        | Recommendation, unvetoed      |
| 14  | pi 0.80                         | Stay on 0.79.10; the 0.80 migration (model store redesign) is a separate future project. Dynamic tool loading noted as a nice-to-have then.                                                                                                                                                  | Recommendation, unvetoed      |
| 15  | Spawn ⊇ agent states long-term? | **OPEN** — whether spawn_agent eventually subsumes state-machine agent states. Unblocked by: living with both.                                                                                                                                                                               | Deferred                      |

## Quadrant 3 — Unknown knowns (extracted context)

- **Consumers: both** — product over RPC _and_ CLI/TUI. Protocol-event stability and TUI task
  rendering both matter; neither is a second-class citizen.
- **"VM" = cloud sandbox over RPC**: the host reaps the process at the first terminal. This
  hardened the terminal rule from a design preference into the system's central invariant.
- **Done = live evals** (red/green + falsification per `/write-eval`). The eval seam gaps
  (LM-E1) are therefore mandatory work, not nice-to-have.
- **Centralize all subagent logic & options** — one `SubagentSpec` + one executor is the only
  way any subagent exists; spawn tool and agent states are two thin spec builders over it.
  forkContext behavior is identical across both.
- Surface taste (accepted as shown in the walk): tool name `spawn_agent`; no `system_prompt`/
  `model` params in v1 (fixed worker identity layer; agent-definition files later); the
  B1-B4 transcript fragment wordings; the TUI task-tree sketch with "held awake by tN".
- Elegance bar: one owner per concern; big-bang refactors are acceptable when evals cover them.

## Quadrant 4 — Unknown unknowns (landmine cards)

38 cards from a three-agent sweep (pi loop/tools; session/RPC/persistence/TUI; observers).
Root finding, triple-confirmed: `terminal === quiescent === reap` and "one agent at a time"
are threaded through every layer. Condensed; status marks: **[absorbed]** = design handles it,
**[sharp]** = builder must handle it explicitly, **[latent]** = pre-existing bug escalated.

### pi loop mechanics (vendored — work within, can't edit)

- **LM-P1 [sharp]** Control results are last-writer-wins (`afterToolCall` → plain assignment,
  turn-runner.ts:2146,1330,1590) and `terminate` needs EVERY batch result (agent-loop.js:344).
  Two control tools, or a control tool + a converting bash, in one parallel batch silently
  defeat each other. → Control tools (`ask_user_question`, `select_state_machine_state`,
  `create_state_machine_definition`) get `executionMode: "sequential"`; control capture
  becomes an asserting queue.
- **LM-P2 [sharp]** A queued steer/followUp revives a terminated run (agent-loop.js:87,154).
  → Settlements live ONLY in TaskManager's pull queue (`nextSettled()` FIFO), delivered by our
  loop as re-prompts; mid-run steer is best-effort, gated on "no control result captured".
  Note `steeringMode` defaults to `"one-at-a-time"` (agent.js:122) — set `"all"` if steering.
- **LM-P3 [absorbed]** pi's `onUpdate` pipe + `pendingToolCalls` die when execute resolves
  (agent-loop.js:416-446) → TaskManager owns output buffers and the turn-open gate outright;
  task UI events bypass the Agent event system (emitting after `agent_end` throws, agent.js:393).
- **LM-P4 [absorbed]** `agent.abort()` never reaches backgrounded work → per-task
  AbortControllers; interrupt drives TaskManager directly and **emits the terminal itself**
  (today interrupt is a silent no-op if the parent already unwound, turn-runner.ts:852-879).
- **LM-P5 [sharp]** Detached bash children are orphaned on harness exit — the reaper
  (`killTrackedDetachedChildren`) only runs in pi's own modes, never in duet
  (src/cli/shutdown.ts has no call). → TaskManager owns a shutdown reaper; keep
  `detached: true` so process-group kill works.
- **LM-P6 [sharp]** `withDefaultBashTimeout` (tools.ts:59-70) hard-kills at 600s and
  prompts.ts:35-37 promises that kill. → Neutralize the inner timeout AND rewrite the tool
  system prompt in the same change; the wrapper's budget takes over the runaway-command story.

### Session / RPC / persistence / protocol

- **LM-S1 [absorbed]** Terminal emission is multi-exit today (runTurnChain:617,
  runAgentWorker:1843, controllerResultToTerminal:969) → single-exit through the one
  `computePendingWork` decider. With that, RPC's "first terminal ⇒ reap" (rpc.ts:371-388)
  and one-shot `run.ts` keep working unchanged.
- **LM-S2 [latent]** `state.json` writes are non-atomic, fire-and-forget, unserialized
  (session.ts:692-703, :479) — torn writes already possible; parallel children raise odds.
  → temp-file + rename + single-flight coalescing queue.
- **LM-S3 [sharp]** Persisted `status:"running"` has no resume story; held-open turns make it
  the common persisted state. → hydrate reconciles to recovered/interrupted + lost-task
  reminders (task descriptors persist in `TurnState.tasks`; ids stay monotonic across restart).
- **LM-S4 [sharp]** Usage: `turnUsage` is nulled when the parent chain settles
  (turn-runner.ts:620) and `commitTerminalCost` adds cumulative totals per terminal
  (session.ts:522) → ledger owned by the turn's task-set lifetime; per-task sub-ledgers;
  delta-based cost commit; origin-aware TUI attribution.
- **LM-S5 [absorbed]** Sleep scalars (`restoreSleepAfterTurn` boolean, `cancelWake` on prompt,
  scalar status) conflict with tasks → sleep derives from the task set; wakeAt is per-task;
  Session-side duplicates (`normalizeTerminalEvent` sleep rewrite) simplify away.
- **LM-S6 [sharp]** Protocol has no task vocabulary; TUI renders one linear stream and drops
  `origin` (session-subscription.ts:103); idle flips on any terminal. → `task_started/
task_output/task_settled` during-events with stable ids + owner linkage; task ids in
  `TurnEventOrigin`; TUI task lanes + "held awake by tN" status; late-attach recovery reads
  task state, not `lastTerminal`.
- **LM-S7 [sharp]** RPC stdout: no drain handling, no heartbeat (rpc.ts:99-101) → drain-aware
  writes + periodic heartbeat so hosts distinguish held-open turns from hangs.

### Observers / router / compaction / park / evals

- **LM-R1 [sharp]** Single-parent guard (turn-runner.ts:1776) stays; settlement re-prompts are
  sequential worker passes owned by the loop; a real parent-slot queue arbitrates user prompts
  vs. transition enforcement vs. settlements.
- **LM-R2 [sharp]** `ModelRouter` is non-reentrant mutable state (router.ts:113-128) → child
  spawn classification uses a stateless classify+resolve seam, never the shared instance.
- **LM-R3 [sharp]** `noteTurnStart` on every worker pass wipes sticky facts + pending
  step-triggers (router.ts:181-185) → internal re-prompts are marked continuations.
- **LM-R4 [sharp]** Step-triggers substring-match tool-result text (step-triggers.ts:39-44)
  → exclude task-plumbing text ("still running", settlement notices) from `routerStepObservation`.
- **LM-M1 [latent]** Steered `<system-reminder>`s are user-role messages the memory observer
  records as user statements (observational.ts:673-825) — the router nudge already leaks this
  way. → strip-sentinel for machine-generated injections (fixes the existing leak too).
- **LM-M2 [latent]** The documented `:sub:` memory scoping (config.ts:14-22) was never
  implemented; children share the parent's session id and race the shared `wireGuardHorizon`.
  → decision #10 implements the minimal true version.
- **LM-K1 [sharp]** Park contradicts today's prompts ("no idle/hold selection", prompts.ts:198;
  `LOOP DETECTED` reminder, turn-runner.ts:1133-1146) and the string-literal suspension
  predicates (`currentScheduledState` only knows poll/timer, state-machine-session.ts:67).
  → reconcile prompts, exempt park from loop detection, extend Typebox unions
  (tools.ts:353-359, 227-231) and every `kind ===` check; only the controller switch is
  compiler-guarded.
- **LM-K2 [sharp]** State-agent ask removal has wide blast radius: `recordStateAskedUser`,
  `enforceTransitionAfterAnsweredAsk`, `isAwaitingUserAnswer`, prompts.ts:197-198, and the
  answered-ask eval family all rewire to park semantics.
- **LM-C1 [sharp]** Compaction front-evicts oldest messages — exactly the early "still
  running" results carrying task ids (state-compaction.ts:77-109) → pin live-task tool
  results; `task_output` answers from TaskManager so transcript loss is recoverable.
- **LM-E1 [sharp]** Live evals can't observe held-open waits: 15-min floor on poll/timer
  (tools.ts:1279), 120s test budgets, no fake clock → injectable clock + test-configurable
  floor and wait budget + deterministic short fake work. Mandatory (done = live evals).
- **LM-G1 [latent]** The guardrails firewall is dead code — `createFirewall`
  (guardrails/firewall.ts:7) has no call site; `beforeToolCall` never attached. No
  pre-execution gate exists today. If wired later: `beforeToolCall` runs in the sequential
  prepare phase (serializes batch prepare), and result inspection needs a new seam (it would
  see the "still running" stub, not the settlement).

## Facts the builder must confirm before coding

1. Exact revive semantics of followUp vs steer after a `terminate: true` batch in 0.79.10's
   `agent-loop.js` (outer-loop re-entry conditions) — decides the settlement-delivery gate.
2. That one `executionMode: "sequential"` tool forces the _whole_ batch sequential
   (agent-loop.js:255-260) and what that costs for common batches.
3. Whether `recall_memory` reads are session-scoped such that a `:sub:` child still benefits
   from the parent's memory (decision #10 assumes yes).
4. `ShellStateHandle`'s process-group kill pattern (shell-state-handle.ts:83) as the template
   for task abort + the shutdown reaper.
5. How eval helpers drive sessions today (docker-gated, `EVAL_MODEL`) — where the clock/budget
   injection seam fits.

## Tweakable build plan (sorted by likelihood-of-tweaking, not order)

**Judgment calls (most likely to move — flag disagreement early):**

1. Settlement delivery mechanics: pull queue + loop-owned re-prompts; steer only mid-run,
   gated; batching N settlements into one re-prompt. (Alternatives: followUp queue, pure steer.)
2. Park semantics wording: the nudge text, loop-detection exemption, decision-prompt rewrite.
3. Usage/cost ledger shape: per-task sub-ledgers + delta commits (alternative: high-water mark).
4. Protocol task events + TUI task-lane rendering (what ships v1 vs. follows).
5. Wait budget default (120s) + which tools are backgroundable (bash + spawn_agent v1).

**Mechanical (trust-you-on-this):** 6. `TaskManager` (~300 lines, no external deps, unit-tested: barrier, stop ordering, FIFO,
scopes/cascade, wait budget). 7. `StateMachineDecisions` extraction (planDecision/recordSettled over state-machine-session.ts
helpers, verbatim moves). 8. `createSubagentExecutor` extraction from createStateAgentHandle; spawn tool + task tools. 9. Single-exit terminal decider; loop replacing driveStateMachineResult/wake/restoreSleep. 10. Atomic persistence, shutdown reaper, prompts.ts rewrite, schema unions, router seams,
memory strip-sentinel + `:sub:` derivation, RPC heartbeat. 11. Eval seams + the live eval suite (spawn parallelism, budget conversion, background nudge,
held-open→complete, park, interrupt-kills-all, lost-task resume).

## Kickoff — SUPERSEDED

> The spec has been written: see [README.md](README.md) (slice graph, module graph,
> invariants, Next Agent Prompt) and `slices/01-14`. This map remains the planning record —
> the decision ledger above is still binding and is referenced by the spec. The build plan
> and tweakable-plan sections above are superseded by the slice files where they differ.
> Implementers start from README.md, not from this file.
