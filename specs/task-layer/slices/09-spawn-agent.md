# 09 — spawn_agent: subagents on the task rails

**Contract unlocked:** subagents are ordinary tool calls — parallel via the existing batch
parallelism (`toolExecution: "parallel"`), backgroundable, stoppable, depth-2 with cascade,
scoped lazy memory. LM-R2, LM-M2; ledger #6(enforcement), #8, #9, #10.

**Seam:**

- `spawn_agent` tool in task-tools.ts: builds a restricted `SubagentSpec` from the v1 public
  schema (`assets/transcript-fragments.md` — binding: prompt, fork_context, cwd,
  allowed_skills, run_in_background, timeout; NO model/system_prompt). Runs via the slice-05
  executor as a TaskManager task (`kind: "subagent"`) under the caller's scope, through the
  same slice-08 budget/background machinery (B2 wording on background start).
- Child model: `classifySpawnModel` (slice 05) — concrete parent setting inherits; virtual
  setting → one stateless classifier call on the child prompt.
- Child memory (ledger #10): derive `parent:sub:<taskId>` memory session + per-child wire
  horizon instance (the shared `wireGuardHorizon` at turn-runner.ts ~:2158-2182 is mutated
  in place by every transform — under parallel spawns that's a wire-shaping correctness bug,
  not just scoping); no routine child observer; observation only via scoped
  `ensureMemoryCoverageForCompaction`; child scratch dropped at scope close. **Pre-coding
  check (map fact #3):** confirm `recall_memory` from a `:sub:` session still reads useful
  parent/global rows (src/memory/ recall path; `recall-memory-cross-session.eval.ts` is the
  reference) — if not, reopen ledger #10 with the user.
- Recursion: children get the full wrapped toolset incl. spawn; depth beyond 2 rejected at
  the executor boundary; child scope close cascade-stops its tasks. Descope valve: config
  clamp to depth 1 (record in README if pulled).
- `ask_user_question` excluded from every child toolset (machinery removal is slice 10).

**Run:** "spawn three agents to survey these three directories in parallel, then summarize"
— overlapping `task_started` intervals, distinct origins, batched settlements, one terminal.
A backgrounded spawn survives the parent pass; `task_stop` on a parent task kills its
children.

**Verification:** live evals red-first w/ falsification: `task-spawn-parallelism` (overlap +
distinct origins; falsify by serializing), `task-subagent-scope-cascade` (falsify by
disabling cascade — fixture PID survives), child-model-inheritance (poisoned-router
assertion; falsify by routing through shared ModelRouter), scoped-memory (falsify by reusing
the parent session id). Unit: two concurrent forkContext children don't cross-mutate
horizons. Parity re-anchors: `state-machine-agent-{fork-context,model}.eval.ts` prove one
executor serves both builders. Concurrent-usage sum test: per-task sub-totals equal the
aggregate.

**Must stay green:** slices 07-08 gates; `reflection-session-isolation.eval.ts`.

**Feedback that would change this slice:** whether children may also get `run_in_background`
day one (currently yes — full powers per ledger #9); tool name `spawn_agent`.
