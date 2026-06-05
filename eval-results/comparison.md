# Eval Suite Model Comparison

All three runs reached bun's summary line and ran the same 150 tests across 65 files. No log was missing, truncated, or crashed before its summary (no auth-error / no-summary cases). Counts below are taken verbatim from each log's summary.

## Summary

| Model                 | Pass | Fail | Total |
| --------------------- | ---- | ---- | ----- |
| Sonnet 4.6 (baseline) | 138  | 12   | 150   |
| DeepSeek V4 Pro       | 133  | 17   | 150   |
| GLM 4.7               | 131  | 19   | 150   |

Notes:

- Sonnet's summary also reported `1 error` in addition to `12 fail`; that error is one of the 12 failing tests categorized by bun as an error rather than a plain assertion failure (138 pass + 12 fail = 150).
- DeepSeek's run took ~4351s (one test, "state machine agent stays in state scope", hit the 600s timeout; "judgeNarrativeShape" hit its 180s timeout). GLM ran in ~2082s, Sonnet in ~2998s.

## DeepSeek V4 Pro vs Sonnet 4.6

**Regressions — failed by DeepSeek, passed by Sonnet (9):**

- /relay routing > inline /relay flips a small task from todo_write to a state machine
- prompt cache resume > reuses cached tokens after resuming from serialized TurnState
- recall_memory implicit triggers > named referent defined in the same turn stays at zero recall
- reflection judges — judge the judge > judgeNarrativeShape returns valid=true on narrative rows (timed out at 180s)
- RPC CLI mode > accepts a multimodal prompt with an attached image
- RPC CLI mode > stitches three turns together (introduce → recall → multimodal extension)
- state machine agent stays in state scope > a planning sub-agent plans instead of implementing across repeated runs (timed out at 600s)
- structured output > returns structured output from multimodal content
- unit-sized reflections > known user steers from the source pool survive reflection (judged)

**Improvements — passed by DeepSeek, failed by Sonnet (4):**

- observer priority inference > medium: agent reasoning / hypothesis from tool output
- recall_memory cross-session usage > asking what was done yesterday triggers recall_memory
- recall_memory implicit triggers > advice question that only personalizes via durable memory
- state machine relative cwd via --workDir + --rpc > resolves a relative script-state cwd against --workDir, not process.cwd()

## GLM 4.7 vs Sonnet 4.6

**Regressions — failed by GLM, passed by Sonnet (13):**

- executed state is not misread as a no-op > parent reconciles executed implementing state instead of cancelling as 'nothing ran'
- observer treats tool calls as context > captures a refactor decision reached after a wide grep
- recall_memory implicit triggers > codenamed artifact dropped into a present-tense question
- RPC CLI mode > accepts a multimodal prompt with an attached image
- RPC CLI mode > stitches three turns together (introduce → recall → multimodal extension)
- state machine agent stays in state scope > a planning sub-agent plans instead of implementing across repeated runs
- state machine carries a runtime worktree path forward as override.cwd > sets override.cwd to implement's returned worktree path on the worktree-scoped steps, not on the base steps
- state machine real session c_cGfNEIotLU carry-forward > replays the corrupted-memory-db investigation and carries findings into fix_and_recover
- state machine vs todo routing > multi-phase refactor with many self-contained units routes to a state machine
- state-machine terminal acknowledgment > parent takes a follow-up action after a decided terminal
- structured output > returns structured output from multimodal content
- unit-sized reflections > known user steers from the source pool survive reflection (judged)
- unit-sized reflections > no two rows cover the same distinct insight (judged)

**Improvements — passed by GLM, failed by Sonnet (6):**

- duet memory reflect — global prune > collapses the use-cases hero supersession chain — final state survives, intermediates pruned
- provider context-overflow recovery > halves history and retries after the provider rejects an oversized prompt
- recall_memory cross-session usage > asking what was done yesterday triggers recall_memory
- recall_memory implicit triggers > advice question that only personalizes via durable memory
- recall_memory implicit triggers > named referent with no past-tense marker — pet name
- state machine relative cwd via --workDir + --rpc > resolves a relative script-state cwd against --workDir, not process.cwd()

## Verdict

**Sonnet 4.6 (baseline):** Strongest of the three at 138/150. Its remaining failures cluster in memory reflection quality (alternative-weighing, global-prune retention), recall_memory triggering, OpenAI thinking-trace routing, and the --workDir/--rpc relative-cwd resolution — issues shared broadly across models, suggesting product/harness gaps rather than model-specific weakness.

**DeepSeek V4 Pro:** Slightly behind baseline (133 vs 138, net −5). It gives back 9 evals Sonnet passes while reclaiming 4, for a net regression of 5. Its weak spots are concrete and consistent: multimodal handling (both RPC multimodal cases and structured-output-from-multimodal fail), state-machine scope discipline (the planning sub-agent ran long enough to hit the 600s timeout), /relay routing, and prompt-cache resume. It does edge out Sonnet on two recall_memory cases, the observer-priority inference, and the relative-cwd case. Usable but a step down, and notably slower on this run.

**GLM 4.7:** Furthest from baseline (131 vs 138, net −7) and the weakest overall. It regresses on 13 evals while gaining 6. Its failures are concentrated heavily in state-machine orchestration — worktree override.cwd, terminal acknowledgment, no-op reconciliation, state-vs-todo routing, scope discipline, and real-session carry-forward all fail — plus the same multimodal weaknesses as DeepSeek and extra memory-reflection misses (duplicate-insight dedup, steer preservation). On the plus side it recovers several recall_memory and context-overflow cases Sonnet misses. Fast (the quickest run), but its state-machine reliability gaps make it the least suitable drop-in replacement for the baseline.

**Bottom line:** Neither candidate beats the Sonnet 4.6 baseline on pass count. DeepSeek V4 Pro is the closer of the two (−5) with mainly multimodal and a couple of state-machine/routing regressions; GLM 4.7 (−7) is held back primarily by broad state-machine-orchestration failures. Both share Sonnet's multimodal-structured-output and memory-reflection alternative-weighing weaknesses.
