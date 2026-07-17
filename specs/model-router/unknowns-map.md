# Model Router + Advisor — Unknowns Map

The completed four-quadrant map from the explore-unknowns walk (2026-07-17/18).

> **Superseded for implementation by [`README.md`](./README.md) + [`slices/`](./slices/)** (the
> write-spec plan, 2026-07-18). The decision ledger and landmine cards below remain authoritative
> as constraints; the "Tweakable plan" section at the bottom and the builder-confirm list are
> superseded — start from the README's Next Agent Prompt, not from here.

---

## Quadrant 1 — Known knowns (settled ground)

**The feature.** Two systems sharing one config:

1. **Virtual-model router** — `--model frontier|balanced|economy` (extensible via config). A routing
   table maps prompts (routing rules) to concrete `{model, effort}` targets; entries may target other
   virtual models (re-enters resolution). Routing is decided per turn by a cheap LLM classifier and
   re-checked intra-turn every N steps.
2. **`ask_advisor` tool** — optional per tier; a no-param tool that sends a curated transcript to a
   stronger advisor model and returns advice. Router and advisor trigger each other (see Q3).

**Territory facts (cited).**

- Single model-resolution chokepoint: `resolveModelName` (`src/model-resolution/resolver.ts:41`).
  Virtual resolution is a NEW layer in front of it — it throws on unknown shorthands (`resolver.ts:183`)
  and returns a single Model with no prompt context, so it cannot host the router itself.
- Effort is a separate axis from the model string (`thinkingLevel`, `src/session/thinking-level.ts`);
  router output is `{model, thinkingLevel}`.
- Intra-turn swap mechanism: pi-agent-core `prepareNextTurn` hook (`pi-agent-core/dist/agent-loop.js:126-144`) —
  purpose-built, re-reads `config.model` per step; pi-ai `transformMessages` already handles cross-model
  thinking-block replay (`pi-ai/dist/providers/transform-messages.js:63-114`). No fork needed.
- Classifier pattern exists: `generateStructuredOutput` (`src/core/structured-output.ts:27`) with
  `reasoningEffort: "low"` (memory-system pattern, `src/memory/observational.ts:71`).
- Conditional tool injection precedent: `recall_memory` (`src/turn-runner/tools.ts:557`); per-tool state
  via lazy storage closures (`turn-runner.ts:1630-1646`).
- Vercel AI SDK already present: `ai@^7` in package.json, `@ai-sdk/gateway` transitive,
  `createDuetModelGateway()` wrapper in `src/cli/model-gateway.ts` (used by `duet model` CLI today).
- Verified gateway IDs (2026-07-17, both Vercel AI Gateway and OpenRouter):
  `openai/gpt-5.6-sol` · `openai/gpt-5.6-terra` · `openai/gpt-5.6-luna` · `moonshotai/kimi-k3`
  (vision, 1M ctx) · `zai/glm-5.2` (Vercel) / `z-ai/glm-5.2` (OpenRouter) — **glm-5.2 is text-only**.
  `deepseek/deepseek-v4-pro` is text-only via API today (vision is chat-app-only).
- Anthropic's advisor tool (shipped in beta 2026-04-09): server-side `advisor_20260301` / name `advisor`,
  no parameters, server forwards full transcript; their advisor-side system prompt is unpublished, but
  executor-side prompt blocks are published verbatim (timing block, advice-weight block, Haiku hard-rule
  variant, nudge pattern) — adapt these for `ask_advisor`'s tool description and system-prompt layer.

**The default routing table (final).**

| Tier               | visual       | plan                | implement                                        | writing              | general              | advisor                   |
| ------------------ | ------------ | ------------------- | ------------------------------------------------ | -------------------- | -------------------- | ------------------------- |
| frontier (default) | kimi-k3 high | fable-5 high        | gpt-5.6-sol high                                 | opus-4.8 medium      | gpt-5.6-sol medium   | fable-5, on               |
| balanced           | kimi-k3 high | gpt-5.6-sol high    | gpt-5.6-terra high                               | sonnet-5 medium      | gpt-5.6-terra medium | fable-5, on               |
| economy            | —            | gpt-5.6-luna medium | glm-5.2 medium; `implement-visual` → luna medium | — (falls to general) | gpt-5.6-luna **low** | gpt-5.6-terra medium, off |

Classifier: gpt-5.6-luna, low effort, every 5 steps, freeform `guidance` field appended
(screenshot-style admin guidance).

---

## Quadrant 2 — Known unknowns (decision ledger)

| #   | Question                                                  | Decision                                                                                                                                                                       | Closed by        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 0   | Economy vision fallback (deepseek API vision unavailable) | luna                                                                                                                                                                           | user             |
| 1   | How table becomes a decision                              | ONE classifier call over all entries; structured output picks the route                                                                                                        | user             |
| 2   | Cache-awareness                                           | Classifier prompt only — no code hysteresis; classifier receives prev-turn context to judge "same task"                                                                        | user             |
| 3   | Advisor cap                                               | Rate-limit floor in **steps** (1 per 5, tunable per tier), not a schedule; reroute nudge is cap-exempt                                                                         | user             |
| 4   | Advisor transcript                                        | Pinned first user msg + live observational-memory middle + recent tail; token budget **uniform across tiers**, default ~10k (≤20k) sized off frontier at $0.10–0.20/call       | user             |
| 5   | Config format                                             | `.duet/models.json`, TypeBox; **optional** — built-in internal table is default; CLI export command writes it out for tweaking                                                 | user             |
| 6   | Reroute cadence                                           | Every 5 steps, tunable; **an advisor call also triggers the classifier** (milestone signal)                                                                                    | user             |
| 7   | Naming                                                    | Bare names; table wins; collision with catalog shorthand = load error (must run before `canonicalizeModelName`, `resolver.ts:130`)                                             | user             |
| 8   | UX                                                        | Two-layer display `frontier → gpt-5.6-sol (high)`; new `router_switch` runner event rendered in TUI; `/model <concrete>` pins & suspends routing; `/route` inspector built now | user             |
| 9   | Exemptions                                                | Memory actor, classifier, advisor, explicit state models exempt; **per-state sub-agent models MAY name a virtual** (re-enters resolution with that sub-agent's context)        | user + territory |
| 10  | Advisor SDK wiring                                        | AI SDK gateway provider against existing gateways/keys                                                                                                                         | territory        |
| D1  | Advisor stack                                             | Vercel AI SDK via existing `createDuetModelGateway()`; plain `generateText` now (no zod); structured outputs later may add zod                                                 | user             |
| D2  | `usageByModel` key                                        | **Concrete model id** (real per-model spend; `/route` carries virtual context)                                                                                                 | user             |
| D3  | `/thinking` vs router effort                              | **Router effort always wins**; `/thinking` applies only to non-routed sessions                                                                                                 | user             |

**OPEN items** (what unblocks each) — _status updated at spec time: draft recon resolved two of
the four builder-confirm facts (installed pi-agent passes an `AbortSignal` to `prepareNextTurn`
and wires `agent.signal` into the loop hook; `createGateway({baseURL, apiKey, fetch})` is already
exercised by `src/cli/model-gateway.ts`). Remaining OPENs are owned by slices 01 and 08. A new
landmine was found and is owned by slice 01: the synthesized gateway path declares kimi-k3
text-only (256k), which would make the vision guard route images AWAY from the vision model —
a real catalog entry must land first._

- **Kimi-k3 effort delivery** — kimi falls to the synthesized anthropic-messages path where `reasoningEffort`
  is silently ignored and caps default conservatively (256k/64k, `duet-gateway.ts:79,106-107`). Unblock:
  at build, test how the gateway forwards effort/thinking to kimi; add explicit catalog caps and, if
  needed, a passthrough branch.
- **AI SDK gateway constructor shape** for pointing at duet-gateway base URL — verify `createGateway({apiKey, baseURL})`
  against the installed `ai@7` when writing the advisor call (wrapper already does this; confirm reuse).

---

## Quadrant 3 — Unknown knowns (extracted taste & context)

- **Router ↔ advisor are one system, interlocked both ways**: a reroute fires a cap-exempt advisor
  nudge ("model changed — consider consulting the advisor"); an advisor call triggers a classifier
  check (consults mark natural milestones). This reshaped Q3 and Q6.
- **Always-on**: router defaults to `frontier` for daily use → classifier latency must be invisible
  (lean classifier input: rules + current model + last-step delta, NOT full transcript).
- **Personal harness, move fast**: no external users; config schema can break freely; no versioning
  ceremony.
- **Done = eval-covered**: multiple evals required — (a) a long coding task mixing frontend + backend
  asserting mid-task rerouting to kimi/sol; (b) a challenging task asserting `ask_advisor` fires.
  Eval hooks have precedents: `CapturingRunner` subclass (state-machine-agent-model.eval.ts) and
  `tool_call_start` subscription (state-machine-routing.eval.ts). Evals hit live models (docker-gated).
- **Advisor budget thinking**: expressed in tokens, uniform across tiers — economy advisors naturally
  cost less; dollars were only for sizing the frontier default.
- **Config philosophy**: built-in defaults compiled in; file is an override, not a requirement; an
  export command hands the user the internal table when they want to tweak (mirrors the Droid
  admin-guidance screenshot's spirit: freeform prose rules shape automatic selection).
- Creative-writing route added mid-walk (frontier opus-4.8 / balanced sonnet-5, medium) — economy
  deliberately has none.

---

## Quadrant 4 — Unknown unknowns (landmine cards)

| #   | Landmine                                                                                                                                                                            | Evidence                                                                | Status                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| L1  | AI SDK premise stale: `ai@7` + gateway wrapper already exist; runtime otherwise pure pi-ai; zod peer-dep if structured outputs                                                      | package.json, `src/cli/model-gateway.ts`, bun.lock:38,348               | **Decided (D1)**                                                                                     |
| L2  | Memory transform freezes context budget at construction — swap to smaller model silently overflows                                                                                  | `turn-runner.ts:2050-2063`; closure captures frozen `effectiveContext`  | Sharp edge: make it a live getter                                                                    |
| L3  | Boot-default cascade: virtual default must live in the router layer; `pinnedDefaultModel` throws on non-catalog names; `canonicalizeModelName` silently rewrites colliding virtuals | `run.ts:230-243`, `catalog.ts:333-347`, `resolver.ts:130`               | Sharp edge: router layer owns the default; collision check precedes canonicalize                     |
| L4  | No vision gating anywhere — images to glm-5.2 fail with opaque wire error                                                                                                           | grep: nothing reads `model.input`                                       | Sharp edge: resolution-time guard — route target lacks vision + images present → tier's vision route |
| L5  | `prepareNextTurn` must never throw; classifier/advisor calls not abortable today                                                                                                    | pi-agent `types.d.ts:180`; `structured-output.ts:18-56` has no `signal` | Sharp edge: thread `signal`, catch-all → keep current model                                          |
| L6  | "Step" ambiguity + shared event stream: tick = assistant completion (`message_end` role=assistant); filter sub-agent events via `origin`                                            | `turn-runner.ts:2241`, `protocol.ts:583`                                | Sharp edge: counters are net-new TurnRunner state                                                    |
| L7  | Observations middle empty early in session                                                                                                                                          | `storage.ts:316` populates after first observer pass                    | Closed: live read; early sessions fit the tail budget anyway                                         |

**Smaller sharp edges.**

- `/model frontier` throws today at `session.ts:383` + `slash-commands.ts:438-462`; inline-slash
  (`inline-slash.ts:43`) fails SILENTLY leaving the old model — all three need virtual-aware validation.
- Usage attribution reads live `state.model.id` (`turn-runner.ts:2261`) — after swaps, key on
  `event.message.model` (per D2, concrete id is desired; just use the per-message value, not runner state).
- `lastParentUsageSnapshot.effectiveContextWindow` replays a stale ceiling between swap and next
  completion (`turn-runner.ts:2303-2307`) — cosmetic bar jitter; recompute on swap.
- Routed model is transient across resume (re-classifies) — correct; never persist the concrete id into
  `options.model` (`session.ts:614-623` force-overrides from config on resume).
- sol/terra inherit reasoning-effort passthrough via `openai/` prefix for free (`duet-gateway.ts:69-74`);
  kimi does not (see OPEN).
- Advisor tool: graceful details-tagged refusal on rate limit (recall_memory pattern, `tools.ts:700-708`),
  never throw; forward the `execute()` AbortSignal (3rd arg); `terminate: false`.
- Transcript serializer: export `serializeMessageForObserver` (`observational.ts:1723`); reuse
  `estimateTokens` (`observational.ts:1930`) + `trimMessagesToTranscriptBudget` (`observational.ts:1556`).
- Executor system prompt for the advisor payload: `parentAgent.state.systemPrompt` is the fully-resolved
  string (layers baked at build, `turn-runner.ts:2027`) — quote it as content, never as advisor system prompt.
- New event precedent: define `TurnRouterSwitchEvent` beside `TurnSystemEvent` (`protocol.ts:779-793`);
  session forwards during-events untouched (`session.ts:454-472`); TUI branch in
  `session-subscription.ts:100-148`.
- Git history is clean — no prior routing attempt to salvage or fear.

**Builder must confirm before coding** (small facts):

1. Which `prepareNextTurn` context variant the installed pi-agent passes (signal-bearing or not) — if
   not, reach `agent.signal` directly.
2. Kimi-k3 effort/thinking behavior through the gateway (OPEN above).
3. `createGateway` constructor shape in installed `ai@7` (OPEN above).
4. That `readSessionObservations` is callable with the session handle available from the tool storage
   closure without new plumbing.

---

## Tweakable plan — SUPERSEDED by README.md + slices/ (kept for the record)

**Judgment calls (most likely to tweak):**

1. **Classifier prompt** — rules assembly + cache-preference guidance + prev-turn context slice + image
   flag. Alternatives toggleable: how much prev-turn context (last assistant summary vs last N tool names).
2. **Default routing table contents** — the tier/route/model/effort matrix above; ships compiled-in,
   `.duet/models.json` overrides.
3. **Advisor prompts** — tool description + advisor system prompt + reroute nudge text, adapted from
   Anthropic's published blocks.
4. **Cadences/budgets** — classifier every-5-steps, advisor 1-per-5-steps floor, 10k transcript tokens.

**Mechanical (trust-you-on-this):** 5. Router module (`src/model-resolution/router.ts` or similar): table types + TypeBox schema, built-in
default table, `.duet/models.json` loader, collision validation, virtual resolution API. 6. Catalog entries: kimi-k3, gpt-5.6-sol, gpt-5.6-terra (+ caps). 7. `prepareNextTurn` wiring + step counters + `router_switch` event + L2/L5 fixes + D2 usage keying. 8. `ask_advisor` tool + storage closure + transcript assembly + AI SDK call. 9. CLI: virtual-aware `/model`, `/route` inspector, `duet config export` (follow `cli/model.ts` pattern),
default-model handling in run.ts. 10. Evals: mixed frontend/backend rerouting eval; advisor-trigger eval; unit tests for table validation,
collision errors, vision guard, rate-limit refusal.
