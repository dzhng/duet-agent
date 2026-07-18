# 08 — Async surface: budget conversion, background, task tools, settlements

**Contract unlocked:** the feature, on bash. Foreground bash races the wait budget and
converts to "still running" (work continues); `run_in_background` returns immediately;
`task_output`/`task_stop` exist; the turn holds open until quiescence; settlements re-prompt
the parent (batched) inside the open turn. LM-P2, LM-P3, LM-P5, LM-P6, LM-C1, LM-R3;
ledger #3(new behavior), #4, #12, #13.

**Seam:** new `src/turn-runner/task-tools.ts` + edits in tools.ts/prompts.ts/turn-runner.ts.

- `wrapBackgroundable(tool, taskManager, budget)`: execute → `TaskManager.start` +
  `raceForeground`; conversion returns the B1 wording (one builder fn; see
  `assets/transcript-fragments.md` — binding). Bash gains `run_in_background`; its `timeout`
  param is reinterpreted as the per-call wait budget. The task's own AbortController drives
  the process (detached + process-group kill per shell-state-handle.ts ~:83).
- **LM-P6 atomically:** neutralize `withDefaultBashTimeout` (tools.ts:59-70), rewrite the
  `<bash_timeout>` prompt block (prompts.ts:30-38), AND rewrite `evals/bash-timeout.eval.ts`
  (it pins the 600s-kill contract this slice deletes) — one commit.
- `task_output(id?, {wait?})` (no id = list) and `task_stop(id)` — admin lane (no task
  descriptors of their own; sequential executionMode; the batch-serialization cost is
  characterized by slice 01 pin 4). Answers come from TaskManager buffers, never transcript.
- Settlement delivery: loop pulls `nextSettled()`, batches all pending into ONE re-prompt
  pass (B3 wording); mid-run steer best-effort, gated on no captured control result;
  `steeringMode: "all"` if steering is used. Internal passes marked continuations so
  `noteTurnStart` (router.ts ~:181-185) doesn't wipe sticky facts / pending step-triggers
  (LM-R3).
- Shutdown reaper wired into `src/cli/shutdown.ts` (background bash ships here — orphan risk
  starts here; LM-P5).

**Run (the first playable checkpoint):** in the TUI with a small injected budget:
"run `sleep 20 && echo done`, then tell me a joke" → conversion at budget, joke continues,
settlement notice lands, ONE `complete` only at quiescence. `run_in_background` returns
instantly; `task_output` streams; ctrl-C kills everything → one `interrupted`; exiting the
CLI leaves no orphan (`pgrep` the fixture PID).

**Verification:** unit (fake clock): race, detachment (slice-01 pin 5 against real code),
FIFO delivery, batching. Live evals red-first w/ falsification:
`task-foreground-budget-converts`, `task-background-settlement-nudge`,
`task-held-open-quiescence` (first terminal strictly after final settlement),
`task-output-stop` (output survives transcript compaction; stop reaches the process group),
`task-interrupt-kills-all`, `task-scheduled-only-sleeps` (scheduled-only → sleep; mixed →
open). Falsifications: restore inner 600s kill; deliver settlements via followUp (revive
assertion fails); emit complete when parent first settles; abort on budget expiry.

**Must stay green:** everything from slice 07, `rpc.eval.ts` (host still reaps at first
terminal — which now genuinely means quiescent).

**Feedback that would change this slice:** wording tweaks to B1-B3 (one builder each — cheap
now); the budget default; whether MCP tools get wrapped in v1 (currently: bash only;
spawn_agent in slice 09).
