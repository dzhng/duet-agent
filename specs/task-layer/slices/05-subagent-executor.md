# 05 — Subagent executor extraction (behavior-preserving)

**Contract unlocked:** exactly one way any subagent is constructed. Agent states become a
thin spec builder; `spawn_agent` (slice 09) becomes the second. Centralize-all-subagent-
logic is a binding walk decision (map Quadrant 3).

**Seam:** new `src/turn-runner/subagent.ts`.

- `SubagentSpec` — the internal superset: `prompt, systemPrompt?, allowedSkills?, cwd?,
model?, thinkingLevel?, forkContext?` (state-machine.ts:264-335 surface). Public tool
  schemas restrict it; state definitions and future agent-definition files may fill it.
- `createSubagentExecutor(deps)(spec, ctx)` — extracted verbatim from
  `createStateAgentHandle` (turn-runner.ts ~:1248-1401): skill filtering + slash expansion,
  worker identity layer, forkContext seed-prefix behavior (identical for both builders),
  origin-tagged streaming, per-message usage. Returns the `StateAgentHandle` shape renamed
  `SubagentRun` — the old name dies (grep gate: zero `StateAgentHandle` /
  `createStateAgentHandle` references after this slice).
- `classifySpawnModel(prompt, parentSetting)` — stateless classify+resolve on
  `classifier.ts` + `resolve.ts` (ledger #8: concrete → inherit; virtual → one classifier
  call). NEVER the shared `ModelRouter` instance (non-reentrant, router.ts ~:113-128).
  Unused until slice 09 but built and tested here.

**Run:** existing relay/state-machine flows in the TUI — identical behavior.

**Verification:** re-anchor with assertions unchanged:
`state-machine-agent-identity-layer.test.ts`, `state-machine-fork-context-reminder.test.ts`,
`state-machine-cwd-resolution.test.ts`, evals `state-machine-agent-{cwd,fork-context,model,
keeps-task-identity,stays-in-state-scope}.eval.ts`. New seam test: inject a poisoned
ModelRouter that throws on any call; `classifySpawnModel` paths never touch it (LM-R2).

**Must stay green:** entire suite, unmodified.

**Feedback that would change this slice:** none — pure extraction.
