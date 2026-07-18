# Model Router + Advisor — shipped 2026-07-18

Virtual model routing with an interlocked advisor tool. `--model
frontier|balanced|economy` (frontier is the default for bare `duet`) selects a _routing policy_
instead of a model: a cheap LLM classifier picks a route from a prose routing table at every turn
start and every 5 assistant steps, and the harness swaps the parent agent's model+effort
mid-turn. Tiers with the advisor enabled inject a no-param `ask_advisor` tool that ships a
curated transcript to a stronger model; routing changes nudge the advisor, and advisor consults
trigger reclassification. Concrete `--model` names bypass everything unchanged.

Planning provenance: [`unknowns-map.md`](./unknowns-map.md) — the four-quadrant walk that fixed
every design decision before building (decision ledger, landmine cards with file:line evidence,
losing alternatives). The build followed it with the divergences recorded below.

## The reason it works this way

- **Routing is a prompt product, not a code product.** Every judgment lives in prose an admin
  can edit: route descriptions in the table, classifier system prompt, cache-switching
  preference, advisor timing guidance, reroute nudge. Code only enforces mechanics (cadence,
  caps, vision capability). This mirrors the admin-guidance UX the feature was modeled on and
  makes `duet route` + `.duet/models.json` the tuning surface — no rebuild to change taste.
- **One classifier call over all entries** (not per-entry matching): the classifier returns a
  route _name_, schema-constrained to a TypeBox union of the tier's actual routes, so an
  invented route is a validation failure, never a silent misroute. Concrete model + effort come
  only from the validated table.
- **Cache economics live in the classifier prompt, not code hysteresis.** "Switching discards
  the prompt cache; prefer the current model while the kind of work stays the same" is an
  instruction the classifier weighs against a prev-turn hint — fuzzy same-task judgment is
  exactly what an LLM is for, and the preference is tunable prose.
- **The turn runner adapts, never decides.** All routing state (step cadence, pin, advisor
  floor, nudge one-shot, interlock) lives in a deterministic `ModelRouter` class with the
  classifier injected as a function; the runner translates pi-agent events into router calls
  and applies returned `{model, thinkingLevel}` via pi-agent's `prepareNextTurn` hook. Swaps
  are safe because pi-ai's `transformMessages` already downgrades foreign thinking blocks on
  cross-model replay.
- **Advisor mirrors Anthropic's server-side advisor tool** (`advisor_20260301`): no parameters,
  the harness forwards context. Ours quotes the executor's full system prompt _as content_
  (the advisor keeps its own system prompt), pins the first user message, uses live
  observational-memory observations as the elided middle, and budgets a uniform ~10k tokens —
  no advisor-side prompt caching, because at one-shot cadence cache writes cost more than reads
  save.

## Invariants (what must stay true)

- `resolveModelName`, `canonicalizeModelName`, and the catalog are **concrete-only** — a virtual
  name reaching `resolveModelName` is a bug, and virtual names are recognized _before_
  canonicalization and any provider-pin path. One sanctioned seam exists: the CLI selection
  resolver (`resolveCliModelWith` in `resolver.ts`) imports `model-routing`'s table/default to
  pass virtual selections through — a recorded concession from the hard-cutover build, not a
  license for resolution logic to consult routing tables elsewhere.
- `src/model-routing/` is the single owner of virtual-model semantics; ALL tunable prose lives
  in `src/model-routing/prompts.ts` plus the table's route `description` strings. Eval fixture
  labels are oracles — relabeling requires a recorded product rationale.
- `turn-runner.ts` contains zero route/cadence policy conditionals.
- Sessions persist the **selection** (virtual name); routed concrete ids are transient — resume
  reclassifies. Usage is attributed to per-message concrete model ids (`event.message.model`),
  never live runner state.
- Exempt from routing: the memory actor, the classifier itself, the advisor call, and explicit
  concrete state-machine models. Explicit _virtual_ state models resolve via `resolveTierDefault`.
- The classifier input is lean (rules + guidance + current target + bounded prev-turn hint +
  step delta + image flag) — never the full transcript.
- `duet route` composes the exact production classification path — the workbench cannot lie.
- The vision guard (image-bearing work never routed to a text-only model) is enforced in
  `resolve.ts` against catalog `input` metadata; kimi-k3's catalog entry is load-bearing here —
  without it the synthesized gateway path declares kimi text-only and the guard would route
  images _away_ from the vision model.
- `prepareNextTurn` never throws: classifier failure or abort keeps the current model.
- Advisor mechanics: floor of N steps between consults (steps, not calls); the reroute nudge is
  cap-exempt exactly once per switch; failed/refused consults never trigger reclassification.

## Pointers into the code

- Domain: `src/model-routing/table.ts` (`BUILT_IN_ROUTING_TABLE`, `validateRoutingTable`),
  `resolve.ts` (`resolveRoute`, vision guard), `loader.ts` (`.duet/models.json`
  complete-replacement + `exportRoutingTable`), `prompts.ts` (every tunable string),
  `classifier.ts` (`classifyRoute`), `router.ts` (`ModelRouter`), `advisor-transcript.ts`
  (`buildAdvisorTranscript`), `advisor.ts` (`callAdvisor`), `default-selection.ts`
  (the frontier default selection).
- Wiring: `turn-runner.ts` — `initializeModelRouter`, `applyRouterSwitch`, `prepareNextTurn`
  wiring in `createAgent`, `routeStatus`; `ask_advisor` in `src/turn-runner/tools.ts`;
  `TurnRouterSwitchEvent` in `src/types/protocol.ts`.
- Surfaces: `src/cli/route.ts` (`duet route`, `advisor-preview`), `src/cli/config.ts`
  (`duet config export`), `/route` + virtual-aware `/model`/`/thinking` in
  `src/tui/slash-commands.ts`, switch notice + two-layer sidebar in
  `src/tui/session-subscription.ts`/`sidebar.ts`; gateway credential fallback in
  `src/cli/model-gateway.ts` (`createDuetModelGateway`).
- Catalog: kimi-k3 / gpt-5.6-sol / gpt-5.6-terra entries in `src/model-resolution/catalog.ts`;
  gateway clone overrides (`MISSING_MODEL_CLONES`, kimi `high→max` thinking map) in
  `duet-gateway.ts`.
- Tests that pin behavior: `test/model-routing-*.test.ts`, `test/turn-runner-router.test.ts`,
  `test/turn-runner-tools.test.ts`, `test/advisor-transcript.test.ts`, `test/cli-route.test.ts`;
  live evals `evals/model-routing-classifier.eval.ts` (28-case scorecard; a manual
  description-swap falsification run is recorded in the slice-04/10 git history, not as an
  in-tree mechanism), `evals/advisor-trigger.eval.ts` (positive/restraint/disabled/nudge),
  `evals/model-routing-mixed-task.eval.ts` (production-path promotion: kimi visual phase →
  cadence switch → sol backend phase).

## Divergences from the plan (worth knowing)

- **Route descriptions are the classifier's substance.** The first build condensed the map's
  route wording; accuracy suffered (a css-fix prompt routed to implement). Restoring the map's
  richer prose per route recovered 100% on the scorecard. Lesson: never abbreviate the table's
  descriptions — they are the model-facing spec.
- **Latency is not a contract.** The scorecard's frozen 1600ms p50 ceiling flaked purely on
  gateway variance (1332→2743ms across same-code runs at 100% accuracy). The assertion is now a
  5s sanity bound; recorded p50/p95 is the tracking signal.
- **Gateway credential fallback belongs to the gateway constructor.** A first advisor build
  bridged env vars around `createDuetModelGateway`; rejected as a compat shim — the
  DUET-key-else-Vercel-key precedence now lives inside the constructor for every caller.
- **Intra-turn rerouting was planned as optional phase 2** but shipped in phase 1:
  pi-agent-core's `prepareNextTurn` made per-step swaps nearly free, and the promotion eval's
  mid-turn kimi→sol switch is the feature's signature behavior.
- **Virtual sub-agent state models classify via `resolveTierDefault`**, not a live classifier
  call — deliberate latency choice recorded during the build.
- **The economy tier's planned deepseek-v4-pro vision fallback died in planning**: DeepSeek V4's
  API is text-only (vision is chat-app-only); luna took its place.
- **Advisor timing guidance needed normative boundaries.** Anthropic's published broad guidance
  under-triggered; the shipped tool description makes consultation mandatory for consequential
  architecture / conflicting constraints / important unknowns and forbidden for routine local
  work — measured, not vibes (see the tuning log preserved in git history of the slice files).

## Dead ends

- Per-entry yes/no route matching (planning): rejected for ordering fights and fuzzier LLM
  judgment than pick-one-route.
- Code-level switch hysteresis: rejected — taste belongs in prompts.
- Env-var bridging for gateway credentials: rejected as sediment (see divergences).
- A hard network-latency eval gate: rejected after provider-variance evidence.
- Dollar-denominated advisor budget: rejected — uniform token budget across tiers, with dollars
  used once to size the default (~10k ≈ $0.10 on fable input).

## Provenance & evidence (in-tree)

- [`unknowns-map.md`](./unknowns-map.md) — the full planning record: decision ledger (rows 0-10
  - D1-D3), landmine cards, losing alternatives. The feature was modeled on a Factory Droid
    admin routing-guidance screen (freeform prose rules shaping automatic selection) and
    Anthropic's advisor tool docs.
- [`assets/probe-baseline.md`](./assets/probe-baseline.md) — first live classifier baseline
  (8 canonical prompts, all routed correctly, pre-tuning).
- [`assets/tui-switch-notice-frame.txt`](./assets/tui-switch-notice-frame.txt) /
  [`assets/tui-route-inspector-frame.txt`](./assets/tui-route-inspector-frame.txt) — real TUI
  frames captured in docker for the visual gate; an unprimed critique drove the switch-notice
  rewrite (prose trigger, from→to models). Note: banner/header oddities in these frames are
  fake-harness fixtures, not production rendering.
- Promotion evidence, scorecards, and tuning logs: preserved in the slice files' git history
  (removed from the tree at close; `git log -- 'specs/model-router/slices/*'`).

## Operational note (as of close)

`gateway.duet.so` errored on all routing targets (and intermittently on luna) throughout the
build — every live verification ran via `AI_GATEWAY_API_KEY` (Vercel) or OpenRouter. Enabling
`moonshotai/kimi-k3`, `openai/gpt-5.6-sol`, and `openai/gpt-5.6-terra` on the duet gateway is an
open service-side action item; the harness needs no code change when that lands.

## Post-close review (2026-07-18)

A full three-lens review (refactor-clean shape audit, independent Codex code review, docs pass)
ran after archival and produced one fix batch (commit `780d40b`) plus these durable records:

**Fixed post-close.** One owner for the routing catalog adapter + `pinnedModelReference`
(`resolver.ts`); loader's permissive fallback deleted (adapter now required); one virtual-chain
kernel shared by validation and runtime; classifier effort read from the table; `model-gateway`
moved to `model-resolution/` (package cycle broken); lazy advisor resolution + fable-5
OpenRouter mapping (OpenRouter-only startup crash); boot honors a replacement table's
`defaultTier`; concrete-started sessions load the project table; tier switches rebuild advisor
policy; atomic advisor consult lifecycle (`beginAdvisorConsult`/`endAdvisorConsult`) closing a
parallel-call rate-limit race.

**Regression caught by the eval sweep, fixed.** Slice 06 changed the `/model` pin confirmation
wording and broke the live inline-slash eval's pinned phrase (`next turn will use`). Lesson
recorded: `bun run test` does not run evals — a slice whose "stays green" list names an eval
must actually run that eval; wording surfaced to users is contract, and the eval is its pin.

**Recorded, deliberately not built:**

- Table-authority invariant: only the runner's loaded table is fully authoritative; pre-boot
  virtual checks approximate with the loaded-at-boot table (post-fix) — never add a third
  notion of "the table".
- Advisor pricing in `advisor-preview` is a hand-labeled approximation; the strictly better
  version is a `cost` override in `MISSING_MODEL_CLONES` fixing attribution everywhere.
- `cli/route.ts` hosts probe + advisor-preview; split when it grows again.
- After the adapter unification, a `turn-runner/routing.ts` extraction is the natural next
  decomposition of turn-runner.ts — do it for ownership, not line count.
- `TurnRouterSwitchEvent` mirrors `RouterSwitch` deliberately (protocol independence); the
  trigger union is written in three places — collapse if it ever changes.

**Eval-sweep operating note.** Memory embeddings hard-require `DUET_API_KEY`
(`src/memory/embedding.ts`), so recall/memory evals cannot pass with the key blanked or the
duet gateway down — an eval run configured around the gateway outage will fail those for
environmental reasons. Distinguish with a pre-feature baseline run before treating them as
regressions.

**pi-ai upgrade probe (2026-07-18).** Checked whether newer pi-ai ships the routed models
natively. The 0.79 line (latest 0.79.10) does not — `MISSING_MODEL_CLONES` stays. The 0.80 line
(0.80.10) is a breaking redesign that removes the static catalog entirely (`getModel` is gone;
models live in a dynamic `createModels()` store with `refresh()` pulling live provider
catalogs, and `ThinkingLevel` changed shape). So the clones' removal condition is now: they die
with the whole static-spec mechanism during a future pi-ai 0.80 migration — a real project
(resolution, transports, capability sourcing move to the live store), not a version bump. Note
also pi-agent-core exact-pins its nested pi-ai, so root must stay on the identical version or
the `Model` type graph splits.
