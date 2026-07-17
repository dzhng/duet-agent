# 05 — ModelRouter state machine + turn-runner wiring + `router_switch`

## Contract unlocked

A session started with an explicit virtual model classifies at turn start and re-checks every 5
steps; mid-turn swaps are safe (context, usage, abort), visible as events, and deterministic to
test. Default is NOT flipped yet — this slice is the mechanism firewall.

## API seam

`src/model-routing/router.ts` — `ModelRouter`, a plain deterministic class, **zero pi-agent
imports**, classifier injected:

```ts
new ModelRouter({table, tier, classify, resolveCatalog})
  .initialTarget(ctx)                 // boot, pre-classifier (tier general route)
  .noteAssistantStep(delta)           // tick = PARENT assistant message_end only
  .noteAdvisorConsult()               // forces classify at next prepare (interlock half)
  .pin() / .unpin()                   // /model <concrete> suspends routing
  .shouldClassify()                   // cadence ∨ advisor milestone ∨ first turn
  .prepareTurn({hasImages, prevTurnHint, signal}) → RouterSwitch | undefined  // NEVER throws
  .advisorGate() → {allowed, stepsUntilAllowed}   // floor: 1 per minStepsBetween steps
  .takeRerouteNudge() → string | undefined        // set on switch, consumed once, cap-exempt
  .status() → RouterStatus            // feeds /route + TUI
```

`src/turn-runner/turn-runner.ts` — adapter only (composition, no policy):

- Construct `ModelRouter` when the session model is virtual; wire `prepareNextTurn` on the parent
  `Agent` (installed pi-agent passes an `AbortSignal`; the loop applies returned
  `{model, thinkingLevel}` — verified by two drafts, `agent.js:292`). On switch: swap model +
  effort **atomically**, emit the event.
- Step ticks from assistant `message_end`, parent `origin` only (map L6).
- Classifier failure/abort ⇒ keep current model, state intact (map L5) — enforced at the
  `ModelRouter` seam (tested with a throwing fake classifier), not by scattered try/catch.

**Swap-safety fixes that land here (preconditions, not separable):**

- L2: memory transform's `effectiveContext` becomes a live getter (`turn-runner.ts:2050-2063`);
  swap-to-smaller-model must not overflow.
- D2: usage keyed on `event.message.model`, not live `state.model.id` (`turn-runner.ts:2261`);
  `lastParentUsageSnapshot.effectiveContextWindow` recomputed on swap (`:2303-2307`).
- Resume transience guard: routed concrete id never written into `options.model`
  (`session.ts:614-623` force-override is the backstop — assert it).

`src/types/protocol.ts` — `TurnRouterSwitchEvent {type: "router_switch", tier, route, fromModel,
toModel, thinkingLevel, trigger: "turn_start"|"cadence"|"advisor", rationale, origin?}` added to
`TurnDuringEvent` (beside `TurnSystemEvent`, `:779-793`; note: NOT `turn-runner/protocol.ts` —
draft A's map correction). Emit only when model or effort actually changes. Session forwards
during-events untouched (`session.ts:454-472`) — no session code.

## What the human can run

`duet --model frontier "<task that changes character midway>"` — classification at turn start,
re-check every 5 steps, `router_switch` visible in the raw event stream (TUI rendering is 07).

## Verification

- `test/model-routing-router.test.ts` (fake classifier + fixtures): cadence fires at 5 not 4;
  advisor consult forces early classify; pin suspends/unpin resumes; throwing/aborting classifier
  ⇒ `undefined` + state intact; nudge produced once per switch, survives a closed advisor gate;
  floor counts steps not calls.
- `test/turn-runner-router.test.ts` (`CapturingRunner` pattern): forced mid-turn swap across API
  families (anthropic-messages → openai-responses with thinking blocks present) via scripted fake
  classifier — turn completes, event payload correct, `usageByModel` carries both concrete ids
  summing to total, no overflow after swap-to-smaller (L2), sub-agent events don't tick the
  parent counter, interrupt mid-classify leaves model unchanged.

## Must stay green

All `turn-runner-*.test.ts` (esp. usage-by-model, events), `session-model-switch.test.ts`,
memory suites (L2 getter must not disturb them), `evals/state-machine-usage-by-model.eval.ts`,
prompt-cache eval. Non-routed sessions byte-identical.

## Feedback that would change this slice

If cross-model replay breaks in practice despite pi-ai's `transformMessages`, renegotiate to
turn-boundary-only swaps — that decision happens here, cheaply, before anything depends on
intra-turn swapping.

## Dependencies

Slices 01 (real cross-family models) and 04 (classifier trusted).
