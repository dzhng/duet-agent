# 12 — Session recovery, atomic persistence, RPC liveness, shutdown

**Contract unlocked:** a held-open turn persists safely, survives unclean process loss as
explicit lost tasks, never resumes impossible promises, and keeps RPC hosts informed while
no terminal exists. LM-S2, LM-S3, LM-S7; D2 context ("cloud sandbox; terminal ⇒ reap").

**Seam:**

- **Atomic persistence** (session.ts ~:692-703): same-dir temp file + fsync + rename;
  single-flight coalescing writer; `dispose()` awaits it. Snapshots serialize synchronously
  at capture (today `snapshotState` embeds the live message array BY REFERENCE,
  turn-runner.ts ~:1424-1429 — an async write can observe mid-mutation state under parallel
  children). **Persist on task transitions too** — a held-open turn with an idle parent
  produces no usage events, so today's cadence would leave state.json stale exactly when
  crash-recovery matters.
- **Hydrate reconciliation** (LM-S3): persisted in-process descriptors → `lost`; persisted
  `status:"running"` → recovered/interrupted, never "pretend work continues"; `nextTaskId`
  monotonic across restart; next parent pass gets ONE synthetic lost-task reminder
  (sentineled, slice 11) with descriptors + last output; scheduled tasks with valid wakeAt
  re-arm. No auto-restart of lost work (deliberate).
- **Session simplification:** delete the duplicate scheduled-state detection
  (session.ts ~:146-147, :239-259, :556-580, :648-664 remnants after slice 07); wake
  scheduling is a projection of scheduled task descriptors through the injected clock.
- **RPC** (cli/rpc.ts ~:98-101): drain-aware writes — task + terminal events lossless and
  ordered; heartbeats coalescing/droppable under backpressure (a lossless heartbeat queue
  could block the terminal that ends the process). Periodic heartbeat while the task set
  holds the process open; heartbeats never enter transcripts, routing, or memory. Fix the
  unhandledRejection handler (~:115-130): it fabricates a `complete` terminal — it must not
  synthesize quiescence while the runner is alive with open tasks (slice 03's per-task
  rejection observers make this unreachable; keep the handler as last-resort with a
  runner-alive check). The driver still awaits the one chain (~:365-388) — its promise now
  simply resolves at quiescence.
- Shutdown: `TaskManager` reaper in `TurnRunner.dispose` + cli/shutdown.ts (5s watchdog
  exists there, ~:10-43).

**Run:** docker RPC eval: start gated background work → observe task events + heartbeats, no
terminal → kill -9 → restart from persisted state → task `lost`, recovery reminder, higher
next id, old process group gone. A slow-consumer test shows writes pause on drain without
losing task/terminal events.

**Verification:** `test/session-task-recovery.test.ts`, extended `session.test.ts`
(torn-write: concurrent persist calls + kill mid-write, reload parses), `cli-rpc.test.ts`,
`cli-shutdown.test.ts`. Live evals w/ falsification: `task-lost-resume-rpc` (falsify: resume
`running` unchanged), `task-rpc-heartbeat` (falsify: remove heartbeat → host-timeout
simulation reds), `task-rpc-shutdown-reaps` (falsify: omit reaper → PID probe alive).

**Must stay green:** `rpc.eval.ts` (reap-at-first-terminal), tui-resume tests
(re-anchored in slice 13).

**Feedback that would change this slice:** heartbeat cadence; whether lost state-machine
tasks should offer auto-resume (currently: no).
