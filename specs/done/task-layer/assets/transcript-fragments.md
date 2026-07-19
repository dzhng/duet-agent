# Accepted user-facing wordings (binding, from the quadrant walk)

Accepted by David 2026-07-18 ("accepted as shown"). Semantic acceptance — keep the content
and register; small copyedits allowed. Each wording has exactly ONE builder function in
`src/turn-runner/task-tools.ts` (or prompts.ts for B4); other code imports the builder,
never copies strings (LM-R4's exclusion filter imports the same builders).

## spawn_agent tool schema (v1 public surface)

```
spawn_agent — Run a subagent as a tool call. Returns its final report.
{
  prompt: string,          // the task; child starts fresh unless fork_context
  fork_context?: boolean,  // seed child with a copy of your transcript
  cwd?: string,
  allowed_skills?: string[],
  run_in_background?: boolean,
  timeout?: number         // wait budget in seconds, default 120
}
```

No `model`/`system_prompt` params in v1 (internal SubagentSpec is the superset).

## B1 — wait-budget conversion (foreground)

```
Task t3 is still running (bash: `npm test`, 2m0s elapsed).
Recent output:
  … 47 passing, 0 failing (suite 3/9)
It continues in the background. Check it with task_output("t3", {wait: 60}),
stop it with task_stop("t3"), or keep working and you'll be nudged when it settles.
```

## B2 — background start

```
Started background task t4 (spawn_agent: "audit auth flows for missing rate limits").
You'll be nudged when it settles; task_output("t4") shows live progress.
```

## B3 — settlement nudge (batched; steer mid-run or re-prompt when idle)

```
<system-reminder>
2 tasks settled while you were working:
- t3 (bash: `npm test`) completed — 312 passing, 0 failing. Full output: task_output("t3")
- t4 (spawn_agent: audit auth flows) completed — final report below.
  [child's final message inline, capped; overflow to task_output]
Act on these or continue; your turn stays open while tasks run.
</system-reminder>
```

## B4 — park-state nudge (end of every turn while parked)

```
<system-reminder>
The state machine is parked at "await-design-approval". If the purpose of this
park is fulfilled, select the next state with select_state_machine_state; otherwise
you may end your turn and the machine stays parked.
</system-reminder>
```

## TUI task tree (accepted sketch, slice 13 target)

```
● parent — reviewing audit results…
  ├─ ✔ t3 bash `npm test` 4m12s
  ├─ ⠙ t4 spawn_agent audit auth flows… 6m03s   [12.4k tok]
  │    └─ ⠙ t7 bash `rg -n rate_limit` 8s
  └─ ◷ t5 poll deploy-status — wakes 14:32
  turn open: held awake by t4, t7
```
