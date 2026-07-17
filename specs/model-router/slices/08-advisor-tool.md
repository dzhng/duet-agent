# 08 — Advisor: transcript library, `ask_advisor` tool, AI SDK call, preview probe

## Contract unlocked

Tiers with advisor enabled inject a no-param `ask_advisor` tool; calling it ships a curated,
budgeted transcript to the tier's advisor model and returns advice — or a graceful refusal when
rate-limited. What the advisor sees and costs is inspectable offline before any live call.

## API seam

`src/model-routing/advisor-transcript.ts` (pure):

`buildAdvisorTranscript({firstUserMessage, executorSystemPrompt, observations, tailMessages,
budgetTokens}) → {text, tokens, truncated}` — priority order: (1) pinned first user message,
(2) fully-resolved executor system prompt **quoted as content, never as the advisor's system
prompt** (`parentAgent.state.systemPrompt` is the complete resolved string, `turn-runner.ts:2027`),
(3) live observational-memory middle (empty early-session is valid — map L7), (4) newest tail
that fits the remaining budget. Uniform budget from the table (default 10k, ≤20k). Reuse
`estimateTokens` + `trimMessagesToTranscriptBudget`; **export `serializeMessageForObserver`**
(`observational.ts:1723`) rather than hand-rolling a serializer — export-only change, memory
system otherwise untouched.

`src/model-routing/advisor.ts`:

`callAdvisor({transcript, model, thinkingLevel, signal}, {gateway?}) → {advice}` — plain AI SDK
`generateText` (D1, no zod) through the existing `createDuetModelGateway()`
(`src/cli/model-gateway.ts` — reuse or relocate the implementation; **no parallel wrapper**).
Confirms the map's remaining builder-facts: installed `ai@7` call shape (pre-verified by the
wrapper's own use) and `readSessionObservations` callable via the lazy tool-storage closure.
Advisor prompts (tool description + advisor system prompt, adapted from Anthropic's published
`advisor_20260301` executor blocks) live in `prompts.ts` — first draft here, tuned in slice 09.

`src/turn-runner/tools.ts` — `createAskAdvisorTool(storage: AskAdvisorToolStorage)`:

- `recall_memory` conditional-injection + lazy-closure precedent (`tools.ts:557`,
  `turn-runner.ts:1630-1646`); injected only when the routed tier's `advisor.enabled`.
- `Type.Object({})` params; `terminate: false`; forwards the `execute()` AbortSignal (3rd arg).
- Rate floor via `router.advisorGate()`: closed → details-tagged graceful refusal
  (`tools.ts:700-708` pattern: `{details: {type: "ask_advisor", rateLimited: true, stepsUntilAllowed}}`),
  **never throws**.
- Success → `router.noteAdvisorConsult()` (the advisor→classifier interlock half, already in the
  `ModelRouter` seam from slice 05).

Preview probe (`src/cli/route.ts` extension): `duet route advisor-preview [--session <id>]` —
prints the assembled transcript, token count, and per-tier cost estimate against a real session
from `~/.duet`. The advisor-prompt analogue of the classifier workbench.

## What the human can run

`duet route advisor-preview` against a fat real session (eyeball payload + cost); then a frontier
session on a hard task where `ask_advisor` appears, fires, and renders advice; economy shows no
tool; a lowered `minStepsBetween` demonstrates the refusal path.

## Verification

`test/advisor-transcript.test.ts` (fixtures): pinned head survives oversized tail; system prompt
lands in content, never the system slot; empty-observations valid; budget respected exactly; no
duplicate pinned message. `test/turn-runner-tools.test.ts` extension: refusal shape when gated;
signal forwarding; `noteAdvisorConsult` on success (fake `callAdvisor`); tool absent for economy.
One live smoke call.

## Must stay green

Memory suites (serializer export must not reshuffle `observational.ts`), tool composition tests,
`duet model` gateway tests, recall-memory evals.

## Human review checkpoint (non-blocking)

Read 2-3 real advisor exchanges + the preview payload; judge advice shape and cost from usage
events. ~5-minute window, decide on evidence, record.

## Dependencies

Slice 05 (router gate + storage closures). Parallel with slices 06/07. The transcript library
part has no dependencies at all and can start any time.
