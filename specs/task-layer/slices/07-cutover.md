# 07 — The cutover: one loop, controller deleted (the pivot)

**Contract unlocked:** `state-machine-controller.ts` is deleted (no facade, no shim). One
loop in TurnRunner; one terminal decider; single-exit emission; interrupt emits its own
terminal. **Behavior-preserving**: same terminals, events, usage numbers for every existing
flow. LM-S1, LM-P1, LM-P4, LM-R1; ledger #1, #3(existing behaviors), #5.

**Seam (turn-runner.ts):**

- `runTurnLoop(command)` replaces `runTurnChain` (~:595) / `driveStateMachineResult`
  (~:1012) / `controllerResultToTerminal` (~:969) / `wake` (~:919) /
  `restoreSleepAfterPromptIfNeeded` (~:936) / terminal-ack + queued-command draining
  (~:601,:710-748) — SIX collapsed behaviors (drain ordering incl. the wake-clobber guard
  at ~:742 is the one the map's list missed). State execution = TaskManager tasks (agent
  states via slice-05 executor; script/poll via shell exec specs); policy = slice-06 module;
  terminals = `computePendingWork` at ONE exit inside try/finally (a thrown pass still
  yields a terminal — today `Session.dispatchTurn` converts rejections to a `system` event
  and `waitForTerminal` hangs, session.ts ~:456-474; add the session-side assertion too).
- **Parent-slot queue** (`ParentLoopInput`: user_command | task_settlements |
  transition_enforcement | terminal_acknowledgment | wake) — deletes BOTH prior mechanisms:
  `startParentPromptDuringActiveStateWork`/`activeStateWorkPrompt` (~:674-708 — its terminal
  bypasses chain bookkeeping today) and the queued-command special-cases. Grep gate:
  `activeStateWorkPrompt` gone. Single-parent guard (~:1776) stays as an assertion the loop
  satisfies. Give `TurnState.followUpQueue`/`queuedCommands` their explicit post-cutover
  meaning (followUpQueue = the user lane of the parent-slot queue; queuedCommands dies).
- **Control capture:** `executionMode: "sequential"` on the three control tools; asserting
  queue replaces last-writer-wins (~:2146-2152, :1330, :1590). **Admin lane:** control tools
  never create task descriptors.
- **Interrupt** (~:852-879 rewritten): close root scope + cancel scheduled + await cleanup
  with SIGTERM→SIGKILL grace escalation (recorded) + clear queues + emit ONE `interrupted`
  terminal even when no worker pass is in flight.
- Internal passes: assert pi steer/followUp queues empty at start (slice-01 pin 3; run-start
  steer drain would contaminate internal passes with queued user text); build the tool array
  once per turn and reuse across passes (per-pass rebuild at ~:1782 would break the prompt
  cache under multi-pass turns); an explicit parent-idle window between passes where
  `/compact` is legal (today compact is locked out for a turn's whole lifetime,
  ~:431-466 — held-open turns would starve it).
- Usage: ledger lifetime = loop lifetime (today nulled in runTurnChain's finally ~:620).
  One terminal per turn keeps `commitTerminalCost` correct as-is.
- Sleep: derives from the task set; `restoreSleepAfterTurn` scalar + `normalizeTerminalEvent`
  sleep rewrite (session.ts ~:147,:556-581) deleted; `scheduleWake` arms from the sleep
  terminal's task-derived wakeAt. Add the wake-rearm-after-mid-sleep-prompt assertion BEFORE
  deleting the scalars (only two pins exist today).

**Run:** the whole product, unchanged: agent turns, relays through agent/script/poll/timer
states, sleep/wake, interrupts, answered asks (still state-agent asks until slice 10).

**Verification:** **entire existing test + eval suite green with unmodified assertions** —
any eval edit in this slice is a red flag reviewed line by line. New seam tests: two control
tools in one batch → asserted rejection; interrupt with parent already unwound emits the
terminal; throw-injection proves every exit path emits exactly one terminal.

**Must stay green:** everything, especially `state-machine-*.eval.ts` (~25),
`turn-runner-{interrupt,active-turns,protocol,serialization}.test.ts`, `rpc.eval.ts`,
`session.test.ts`, usage evals.

**Feedback that would change this slice:** none — this is the ledger's core decision. If the
loop cannot reproduce the six behaviors, STOP and reslice rather than patching evals.
