# 02 — RuntimeClock + verification kit

**Contract unlocked:** tests and live evals can force task start, partial output, budget
expiry, settlement, cancellation, scheduled wake, and process loss without real sleeps or
the 15-minute scheduling floor. LM-E1. This is the seam the done-gate ("done = live evals")
stands on — it precedes every feature that needs it.

**Seam:**

- `src/turn-runner/runtime-clock.ts`: `RuntimeClock { now(); sleep(ms, signal?); schedule(cb,
delayMs); repeat(cb, intervalMs) }`. `SystemRuntimeClock` is the sole production owner of
  wall time for task/schedule lifecycles (existing unrelated timestamping migrates as slices
  touch it). `ManualRuntimeClock` in `test/helpers/` — `advanceBy(ms)` fires due callbacks in
  (deadline, insertion) order and flushes microtasks.
- `TurnRunnerConfig.taskWaitBudgetMs` (public, default 120_000 — ledger #12). Internal
  injected deps carry `clock` and `minimumScheduledDelayMs` (production 15min; direct
  test/eval construction may inject lower — the floor currently closes over `Date.now()` and
  `MINIMUM_STATE_MACHINE_DELAY_MS` in tools.ts ~:1279,1364-1398). Test-only knobs are NOT
  public config.
- `test/helpers/fake-task-work.ts`: deferred unit work recording starts/output/abort/cleanup.
- `evals/fixtures/task-work.ts`: docker-safe subprocess fixture — writes started sentinel +
  PID, emits chosen output, blocks on a release-file gate, records SIGTERM before exit. A
  file gate beats sleeps: the eval controls the exact settlement moment.
- Extend `test/helpers/turn-runner-protocol.ts` (TestTurnRunner) with task-event capture +
  dependency injection. No task semantics in the harness.

**Run:** `bun test runtime-clock task-work-fixture` — a 120s logical budget advances
instantly under the manual clock; the fixture smoke test proves gate + SIGTERM recording.

**Verification:** red-first tests; falsification: swap injected sleep for the system clock —
the manual-clock test must fail its settlement assertion. A config test asserts production
defaults (120s, 15-min floor) are intact (README invariant 7).

**Must stay green:** full existing suite (pure addition).

**Feedback that would change this slice:** the default budget value (ledger #12 was closed
by recommendation — cheap to change here, expensive after slice 08 evals pin it).
