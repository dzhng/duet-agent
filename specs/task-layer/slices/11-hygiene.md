# 11 — Observer / router / compaction hygiene

**Contract unlocked:** internal task plumbing cannot become false user memory, cannot
trigger spurious model rerouting, and cannot be compacted out from under live tasks. Parent
observation happens once per real turn. LM-M1, LM-R4, LM-C1 (enforcement half); ledger #11.
Also fixes two latent pre-existing bugs (map Quadrant 4 escalations 2 and 4-adjacent).

**Seam:**

- **Synthetic-message sentinel** (LM-M1): machine-generated user-role injections (settlement
  steers, router reroute nudges, park nudges, lost-task reminders) carry a sentinel that
  `stripObservationalContextMessages` (observational.ts ~:802-825) recognizes — the observer
  never records them as user statements. This fixes the existing router-nudge leak too.
- **Observer cadence** (ledger #11): `updateMemoryAfterAgentRun` (turn-runner.ts ~:1840)
  fires once at true-turn quiescence + on context pressure — never per settlement/
  enforcement pass. Gate at the call site, not only in observer config.
- **Step-trigger exclusion** (LM-R4): `routerStepObservation` (~:2652) takes an origin/source
  classification; "still running" stubs, settlement notices, and nudges are excluded from
  substring keyword matching (step-triggers.ts ~:39-44) — import the slice-08 wording
  builders, never copied strings.
- **Compaction enforcement** (LM-C1): prove `task_output` returns buffered output after the
  transcript anchor was evicted; live-task pair pinning from slice 04 verified end-to-end.

**Run:** a held-open turn with two settlements → memory inspection (debug-memory fixture
flow) contains neither "still running" nor settlement text as user statements; one observer
pass total; no reroute fired by plumbing text.

**Verification:** extend `model-routing-step-triggers.test.ts`, `turn-runner-router.test.ts`,
memory tests (debug-memory fixture pattern), `state-compaction.test.ts`. Live evals w/
falsification: `task-memory-synthetic-filter` (falsify: remove the strip → observation
contains the reminder), `task-settlement-routing-neutral` (falsify: configure a sentinel
keyword + pass settlement text to the router → reroute fires), observer-cadence (falsify:
observe per pass → count assertion reds).

**Must stay green:** existing memory evals (`reflection-*`, `recall-*`), routing evals
(`model-routing-step-trigger.eval.ts` — real image triggers still fire).

**Feedback that would change this slice:** none — correctness plumbing.
