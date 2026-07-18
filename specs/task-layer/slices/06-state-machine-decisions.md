# 06 — StateMachineDecisions extraction (behavior-preserving)

**Contract unlocked:** state-machine policy (ledger, planning, history, poll gates, loop
detection) is a pure module testable without processes or models. Execution stays in the
controller until slice 07 — this slice only moves the policy out from under it.

**Seam:** new `src/turn-runner/state-machine-decisions.ts`.

- `planDecision(session, decision) → { session', work: PlannedWork }` where `PlannedWork` =
  `{ run: SubagentSpec } | { run: ShellSpec } | { schedule: { wakeAt } } | { terminal } —`
  execution-free descriptions the caller turns into work. (`park` joins this union in
  slice 10.)
- `recordSettled(session, stateName, kind, result, partial?) → { session', outcome }` —
  folds results into the ledger: completed/failed/interrupted recording, poll-gate streak,
  output normalization/capping (`capStreamForPrompt` and friends move here or to a shared
  module `task_output` can also use).
- `planWake(session)`, `supersede`, `failActiveSession`, `markTerminalAcknowledged`,
  `hydrate`/`getSession` — verbatim moves over `state-machine-session.ts` pure helpers.
- Forbidden imports: TaskManager, pi Agent, any executor (README firewall).
- Controller shrinks to a shim calling this module for policy (deleted next slice — the shim
  is allowed to live for exactly one slice).

**Run:** existing state-machine flows — identical behavior.

**Verification:** planner unit tests establishing parity: `state-machine-history-cap`,
`state-machine-persist-override`, `state-machine-poll-success` (policy assertions),
`state-machine-repeated-selection-loop`, `state-machine-output-cap` — same assertions
re-anchored onto the pure module where they touched controller internals.

**Must stay green:** entire suite; all ~25 state-machine evals unmodified.

**Feedback that would change this slice:** none — pure extraction.
