# 03 — TaskManager kernel + quiescence decider

**Contract unlocked:** one pi-free owner of task identity, lifecycle, buffers, budget race,
settlement FIFO, scopes, cancellation — and one pure function that decides terminals.

**Seam:** new `src/tasks/` (zero-dependency library; imports nothing from the app or pi).

- `types.ts`: `TaskId` (`t${number}`), `TaskKind ("tool"|"subagent"|"scheduled")`,
  `TaskStatus ("running"|"scheduled"|"completed"|"failed"|"stopped"|"lost")`,
  `TaskDescriptor` (serializable — THE task shape reused by protocol/persistence/TUI),
  `TaskSettlement`, `TaskSnapshot` (values, not counts).
- `task-manager.ts`: `start(spec) → TaskHandle`, `raceForeground(handle, budgetMs)` →
  settled-result xor still-running (expiry NEVER aborts), `list(scope?)`, `output(id)`,
  `waitForSettlement(id?, waitMs?)`, `nextSettled()` (pull FIFO — the ONLY settlement exit),
  `stop(id, reason)`, `closeScope(scopeId, reason)` (cascade, children first),
  `interruptAll()`, `pendingWork()`, `recover(descriptors) → { lost }`, reaper registry.
  Clock injected (slice 02). Every task promise gets a rejection observer at spawn (an
  unobserved rejection must never escape — RPC's unhandledRejection handler fabricates a
  `complete` terminal, cli/rpc.ts ~:115-130).
- `quiescence.ts`: `computePendingWork(descriptors) → open | sleep(minWakeAt) | complete`
  (ledger #3, verbatim). Pure; takes serializable descriptors so hydrate paths and evals can
  call it on persisted state.

**Invariants pinned by unit tests:** monotonic ids incl. after `recover`; exactly one
terminal transition per task; ordered output chunks; FIFO by settlement time; budget expiry
≠ abort; stop/interrupt/scope-close abort once and await cleanup (the finished-barrier —
successor of `ActiveStateRunCommon.finished`); scheduled tasks carry wakeAt and no in-process
work; depth-2 accepted, depth-3 rejected centrally; scope cascade stops descendants before
the scope's own close resolves.

**Run:** `bun test task-manager quiescence` — instant under the manual clock; a focused test
prints `t1 running → budget elapsed → still running → completed`.

**Verification:** red-first; falsifications: abort on budget expiry (nudge-not-kill fails),
sort settlements by id (FIFO fails), remove cascade (leak test fails).

**Must stay green:** full existing suite (pure addition).

**Feedback that would change this slice:** none — semantics are ledger-fixed; API names are
implementer's judgment.
