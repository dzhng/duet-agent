# 14 — Live-eval acceptance matrix (done-gate)

**Contract unlocked:** the feature is done per the walk's D3 ("done = live evals"): each
central behavior has an outermost-entry-point live eval observed red on a deliberately
broken production path, green after restoration, green in the full suite. LM-E1 closes;
regression umbrella for every LM-\* card except the deferred LM-G1.

**Seam:** no new production abstraction. `evals/helpers/task-eval-harness.ts` only for:
origin-partitioned event/transcript capture, gated-fixture lifecycle, diagnostic dumps,
terminal-order assertions, PID/process-group probes. It must not encode expected semantics.

**Required matrix (each row: only-if proof):**

| Eval                             | Only-if proof                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| task-foreground-budget-converts  | "still running" before release; PID alive; same task later settles                   |
| task-background-settlement-nudge | immediate result; no early terminal; exactly one settlement pass                     |
| task-held-open-quiescence        | first terminal strictly after final in-process settlement                            |
| task-spawn-parallelism           | two children overlap with distinct task origins                                      |
| task-output-stop                 | output served after transcript compaction; stop reaches process group                |
| task-scheduled-only-sleeps       | scheduled-only ⇒ sleep; mixed ⇒ stays open                                           |
| state-machine-park               | park creates no task; parent transitions after the nudge                             |
| task-interrupt-kills-all         | parent + nested child + bash + scheduled all stopped before ONE interrupted terminal |
| task-lost-resume-rpc             | killed process resumes with lost descriptors, reminder, monotonic ids                |
| task-memory-synthetic-filter     | observations contain no task notices or machine reminders                            |
| task-rpc-heartbeat               | heartbeats while held open; terminal absent until quiescence                         |

Most rows land red-first inside slices 08-12; this slice completes stragglers, records each
falsification break in-file, and runs the shipping gate:
`bun run check-types && bun run lint && bun run format:check && bun run test && bun run eval`
(file-writing tests/evals stay docker-gated per repo convention).

Discipline: deterministic wiring/lifecycle evals run once with unguessable sentinels +
negative assertions; prompt-tendency evals (park wording, settlement reactions) run
calibrated multi-iteration per write-eval. "Turn completed" alone is never an acceptance
assertion. Confirm no fixture gate, PID, db, or state artifact remains after runs.

**Must stay green:** the entire suite. When this slice closes, run
[close-spec](../../../.claude/skills/close-spec/SKILL.md) to archive this plan to
specs/done/ as a rationale record.

**Feedback that would change this slice:** additional acceptance rows (e.g. a product-side
RPC host simulation) — cheap to add before the matrix locks.
