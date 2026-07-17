# 02 — Routing domain library (table, loader, resolve)

## Contract unlocked

The routing table exists as a validated, typed, compiled-in artifact with a pure resolution
kernel: given a table, tier, route, and context flags, resolution deterministically produces a
concrete `{modelName, thinkingLevel}` — including virtual re-entry, vision guard, and fallbacks.
No LLM, no IO in the kernel.

## API seam

`src/model-routing/table.ts` (pure domain):

- `RoutingTable`/`TierDefinition`/`RouteRule`/`RouteTarget`/`AdvisorPolicy`/`ClassifierConfig`
  types + `RoutingTableSchema` (TypeBox). Route targets may name another virtual model.
- `BUILT_IN_ROUTING_TABLE` — encodes the map's final matrix **exactly**: frontier default;
  creative-writing routes (frontier `opus-4.8` medium, balanced `sonnet-5` medium); economy
  writing falls through to general; economy general = luna **low**; economy `implement-visual` =
  luna medium; classifier = luna low, `everySteps: 5`, freeform `guidance`; per-tier advisor
  settings (frontier/balanced fable on, economy terra off, `minStepsBetween: 5`,
  `transcriptTokens: 10000`).
- `validateRoutingTable(table, catalogAdapter): RoutingTableIssue[]` — collisions with catalog
  shorthands/aliases (**must run before `canonicalizeModelName`**, `resolver.ts:130`), dangling
  route refs, virtual cycles (report the full path), invalid efforts, non-positive cadences,
  transcript budget ≤ 20k, vision fallback must resolve to a vision-capable model.
- `isVirtualModel(name, table)`, `virtualModelNames(table)`.

`src/model-routing/resolve.ts` (pure kernel):

- `resolveRoute(table, tier, route, ctx: {hasImages}, catalog: {modelAcceptsImages}) →
ResolvedTarget {tier, route, modelName, thinkingLevel, visionFallback, chain}`.
- `resolveTierDefault(...)` for boot, pre-classifier.
- Vision guard lives here: chosen target lacks image input + `hasImages` → tier's vision route
  (map L4). Catalog capability comes through the injected adapter; composition site backs it with
  `resolveModelName(...).input`.

`src/model-routing/loader.ts` (only disk toucher):

- `loadRoutingTable({cwd}) → {table, source: "built-in"|"file", path?}` — `.duet/models.json` is
  a **complete validated replacement**, not a deep merge. Invalid file = loud load error, never a
  silent fallback.
- `exportRoutingTable({cwd, force})` — deterministic formatted JSON; refuses to overwrite
  without `force`.

## What the human can run

Unit tests only — the probe (slice 03) is one slice away and is this library's demo. Acceptable
for a pure kernel.

## Verification

`test/model-routing-table.test.ts` + `test/model-routing-resolve.test.ts`, deterministic fixtures:
built-in matrix values asserted exactly; schema round-trip; collision load error (tier named
`opus-4.8`); cycle detection with path; economy writing→general fallthrough; images+glm target →
luna via vision guard; virtual→virtual re-entry; loader precedence, complete-replacement
semantics, invalid-file loud error; export round-trip equality.

## Must stay green

Everything — nothing outside `src/model-routing/` is touched.

## Feedback that would change this slice

Table shape feels wrong when exported/edited (slice 03 review) → schema iteration happens here
before anything depends on it.

## Dependencies

None (catalog names validate lazily; slice 01 lands the entries). Parallel with slice 01.
