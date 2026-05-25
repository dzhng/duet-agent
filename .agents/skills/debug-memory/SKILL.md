---
name: debug-memory
description: Reproduce observational-memory bugs (reflection, recall, observer, freshness, eviction) by dumping the live `~/.duet/memory.db` into a fixture and driving an eval against it. Use whenever the agent's memory misbehaves — wrong observations, bad reflections, missing recall, runaway tokens — or whenever the user asks to debug, repro, audit, or tune memory.
allowed-tools: Read Grep Glob Bash Edit Write
---

# Debug Memory

The standard operating procedure when memory misbehaves is: dump the live store, narrow to the smallest reproducing slice, seed it into a `MemorySession` fixture, write the failing eval, then iterate on the prompt or code until it goes green. Never tune against the user's running database — every dump is a fixture.

## 1. Dump the live store

`scripts/dump-memory.ts` reads any PGlite memory store and writes JSON. Default source is `~/.duet/memory.db`, default destination is stdout.

```bash
# Everything
bun run scripts/dump-memory.ts --pretty --stats --out /tmp/memory.json

# Only raw observations from the last 7 days
bun run scripts/dump-memory.ts --kind observation --since 7d --pretty \
  --out evals/fixtures/global-reflect/recent-pool.json --stats

# Only reflection rows (to inspect what global prune produced)
bun run scripts/dump-memory.ts --kind reflection --pretty --stats

# A specific session's tail
bun run scripts/dump-memory.ts --session <session_id> --limit 50 --pretty

# High-priority cross-session reflections older than 30 days
bun run scripts/dump-memory.ts --kind reflection --priority high --until 30d --pretty
```

Filters compose with AND. Repeat `--session`, `--priority`, and `--tag` for OR-within / AND-across semantics. `--limit` keeps the newest N rows.

## 2. Place the dump as a fixture

- Eval fixtures live under `evals/fixtures/`. The global-reflect set is the model: `recent-pool.json` (raw dump) + `recent-pool.ts` (typed `SeedObservation[]` export that maps the JSON to seed rows).
- Strip PII before committing. The existing dumps redact customer names, emails, payment identifiers, and any third-party handle that is not an engineering identifier (commit SHAs, PR numbers, file paths, team first names are kept).
- If the bug needs many rows from many sessions, dump the full pool. If it needs one user message + observer output, dump that session id and trim.

## 3. Seed and write the failing eval first

```ts
import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";
import { MY_SLICE } from "./fixtures/global-reflect/my-slice.js";

describe("repro of memory bug X", () => {
  testIfDocker(
    "bug X reproduces against the real-data slice",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        await seedObservations(fixture, MY_SLICE);
        // ...call the misbehaving path (reflectAllObservations, recall, observe)
        // ...assert the bug
      } finally {
        await fixture.dispose();
      }
    },
    180_000,
  );
});
```

Run with `bun run eval evals/<name>.eval.ts`. All file-writing evals must use `testIfDocker` so host-only focused runs skip them — see AGENTS.md.

## 4. Iterate

- Tune the prompt in `src/memory/observational-prompts.ts` or the code in `src/memory/observational.ts` (or `recall.ts`, `storage.ts`).
- Rerun the eval. Repeat.
- When green, confirm the broader eval suite still passes: `bun run eval evals/memory-reflect.eval.ts`, plus any sibling memory evals (`observer-*.eval.ts`, `continuous-memory.eval.ts`).

## Prefer LLM judges over regex/n-gram heuristics for semantic asserts

Many memory properties are easy to describe in English and brittle to encode in regex — "each row reads as a self-contained mini-narrative", "no two rows cover the same insight", "the row anchors to at least one concrete identifier". Reach for `test/helpers/judge.ts` whenever the property depends on whole-text understanding instead of substring matching.

Keep structural / cheap checks as plain assertions: row counts, length caps, persistence of an id, presence of a kind/tag, etc. The judge is for the parts a regex would have to approximate.

### Judge the judge first

A judge prompt is itself code that can drift, over-grade, or be fooled by particular phrasing. Before pulling a judge into a real eval, validate it against hand-crafted positive and negative fixtures so a false-pass / false-fail can be caught against known answers instead of the live LLM output.

1. **Write the dedicated judge.** Put it under `evals/helpers/` as a function per semantic property (e.g. `judgeNarrativeShape(rows)`, `judgeConcreteIdentifiers(rows)`, `judgeDistinctInsights(rows)`). Each wraps `judge()` from `test/helpers/judge.ts` with a tightly-scoped grading prompt. Keep the prompt focused on one property; multi-property judges are harder to debug.
2. **Write the judge-eval.** Create `evals/<name>-judge.eval.ts` and exercise EACH judge with at least one positive fixture (valid=true expected) and one negative fixture (valid=false expected). Use `testIfDocker`. Hand-craft the fixtures so the right answer is obvious to a human reader — narrative rows that include trigger/journey/decision/lesson vs bare-headline rows of the form "X was fixed on Y". Pass the judge result's `reason` as the assertion message so failures surface why the judge disagreed.
3. **Run the judge-eval until green.** A judge whose own eval doesn't pass is not safe to consume. If a fixture flips the wrong way, tighten or loosen the judge prompt, then add a new fixture that locks in the new boundary.
4. **Only then wire the judge into the real eval.** Import the validated judge and call it with live LLM output. If you tighten or loosen a judge prompt later, add new fixtures to the judge-eval first.

Reference implementation: `evals/helpers/reflection-judge.ts` (three reflection judges), `evals/reflection-judge.eval.ts` (six judge-the-judge cases), `evals/memory-reflect-units.eval.ts` (the real eval that consumes the validated judges).

## Decision traces have to clear THREE layers

The decision-trace shape (alternatives considered, user steers, conventions applied, prior precedent, exception flags) is borrowed from Foundation Capital's ["Context Graphs: AI's Trillion-Dollar Opportunity"](https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity) — the durable value of a knowledge worker's day-to-day lives in the precedent graph around each decision, not in the outcomes alone.

Observational memory has three serial stages, and a decision trace only survives if every stage preserves it:

1. **Observer** — reads raw messages, writes one observation row. If the observer drops the user's push-back wording or the rejected approach, no downstream stage can recover them.
2. **In-session reflector** — collapses a session's rows into one rolled-up blob inside `<observation-group>` markers. Same prompt as the global reflector (`buildReflectorSystemPrompt`), so any prompt-level rubric change applies to both layers automatically.
3. **Global reflector** (`duet memory reflect`) — atomizes the cross-session pool into durable rows stamped with `sessionId = __global_reflection__`.

When you're tuning a prompt to capture a new dimension (decision traces, exception flags, attribution), update BOTH the observer prompt (`OBSERVER_EXTRACTION_INSTRUCTIONS` in `src/memory/observational-prompts.ts`) AND the reflector rubric (`buildReflectorSystemPrompt` in the same file). A great reflector prompt fed by an observer that strips the dimension is a great rubric applied to nothing. Gate each layer with its own eval:

- Observer layer: `evals/memory-decision-trace-layers.eval.ts` drives `updateObservationalMemory` end-to-end with messages that contain the dimension, then judges the resulting observation row.
- Reflector layers: `evals/memory-reflect-units.eval.ts` seeds the dump fixture, runs `reflectAllObservations`, and judges the atomic output. Because in-session and global share the prompt, this gate catches both.

## Keep prompt examples independent from eval fixtures

When you tune a memory prompt to make an eval pass, write the worked examples in the prompt with content from a DIFFERENT domain than the fixture. A prompt example that mirrors the fixture is teaching the model to pattern-match the test, not the rule.

Concrete rules:

- Mix domains across the worked examples in the same prompt. Some can be dev (backend conventions, lint config, commit format) — those generalize well — but not all of them. At least one example should sit outside engineering: a hiring rubric, an OKR plan, a household routine, a travel itinerary, an interview scorecard.
- Don't mirror the fixture content. If the fixture is about release commits and CI gateway races, the prompt examples shouldn't also be about release commits and CI gateway races. Pick a different work area (conventions, onboarding, hiring) or step outside work entirely.
- The fixture proves the rule holds on the real data shape the user actually has. The prompt examples teach the rule abstractly. They're complementary, not parallel.
- When you catch yourself reusing fixture phrasing in a prompt (a specific commit SHA, a specific PR number, a verbatim error string from the fixture), stop and rewrite it.

This matters because observational memory runs over every kind of user content — not just code. A prompt that only ever shows dev-shaped examples will under-perform on a hiring, planning, or personal turn.

## Reproducing a session's exact wire payload

When the bug is shaped like "the model lost its footing after
compaction" or "the model is responding as if it never saw my last
turn", the failure is in what the wire-shaping transform actually
dispatched, not in the observations themselves. Reach for the
wire-capture harness:

1. **Copy the failing session's state.json.** Sessions live at
   `~/.duet/sessions/<session_id>/state.json`. Drop it into
   `evals/fixtures/<session_id>/state.json` exactly as-is — don't trim
   messages, the wire shaper cares about every timestamp and role.

2. **Dump the FULL memory store as a sibling fixture.** Both the local
   pack (rows stamped with this session id) AND the global pack (every
   other row) go on the wire, and `loadGlobalPack` ranks against the
   whole table. A filtered dump is the wrong shape:

   ```bash
   bun run scripts/dump-memory.ts --pretty --stats \
     --out evals/fixtures/<session_id>/memory-dump.json
   ```

   If the dump may contain PII and you plan to commit, redact before
   committing (see `evals/fixtures/global-reflect/sandbox-memories.ts`
   for the redaction precedent). For host-only iteration the raw dump
   is fine.

3. **Snapshot the rendered system prompt as a third fixture file.**
   `state.json` does NOT carry the system prompt — the runner
   rebuilds it every turn from the session's cwd + AGENTS.md +
   discovered skills. Both AGENTS.md and the installed skill set
   drift over time, and skill discovery is environment-sensitive
   (e.g. docker `/work` vs host cwd resolved ~10KB vs ~21KB for the
   same session). If the eval rebuilds live, the model silently sees
   a different prompt than the original session ever saw. Pin it:

   ```bash
   bun -e 'import { readFile, writeFile } from "node:fs/promises"; \
     import { capturedWirePayload } from "./evals/helpers/capture-wire-payload.js"; \
     const dir = "evals/fixtures/<session_id>"; \
     const { payload, dispose } = await capturedWirePayload({ \
       turnState: JSON.parse(await readFile(`${dir}/state.json`, "utf8")), \
       memoryDump: JSON.parse(await readFile(`${dir}/memory-dump.json`, "utf8")), \
       sessionId: "<session_id>", \
     }); \
     await writeFile(`${dir}/system-prompt.txt`, payload.systemPrompt); \
     await dispose();'
   ```

   Run the snapshot from a checkout whose AGENTS.md + skill set
   most closely matches the original session (usually the commit
   that was checked out when the session ran). Commit
   `system-prompt.txt` alongside the other fixture files. Evals
   should load it and pass it as `systemPromptOverride` so the
   harness skips the live rebuild:

   ```ts
   const systemPromptSnapshot = await readFile(join(dir, "system-prompt.txt"), "utf8");
   const { payload, dispose } = await capturedWirePayload({
     turnState,
     memoryDump,
     sessionId,
     systemPromptOverride: systemPromptSnapshot,
   });
   ```

4. **Reproduce the wire bytes.** `evals/helpers/capture-wire-payload.ts`
   wires together a fresh `MemorySession`, `rebuildMemoryContextPack`,
   and `createObservationalContextTransform` exactly the way
   `TurnRunner.createMemoryTransform()` does. It returns the same
   `AgentMessage[]` pi-agent would have sent plus structured metadata:

   ```ts
   import { capturedWirePayload } from "./helpers/capture-wire-payload.js";

   const { payload, dispose } = await capturedWirePayload({
     turnState: JSON.parse(await readFile(".../state.json", "utf8")),
     memoryDump: JSON.parse(await readFile(".../memory-dump.json", "utf8")),
     sessionId: "session_VO5yjfS1vV6_",
   });
   try {
     expect(payload.retainedMessageCount).toBeGreaterThan(0);
     expect(payload.dispatchedHasRealUser).toBe(true);
   } finally {
     await dispose();
   }
   ```

   Key fields on the returned `payload`:
   - `systemPrompt` / `systemPromptFiles`: the runner-shaped system
     prompt the model would have seen on this turn, assembled by
     `createSystemPromptWithAppendedLayers` over the captured cwd's
     AGENTS.md plus discovered skills. Pair with `dispatched` to
     drive a real `complete()` call that reproduces the exact wire
     bytes. Pass `{ cwd, systemInstructions, skillDiscovery }` to
     pin known historical values when fidelity matters — the
     default discovers from `process.cwd()`, so running the harness
     from a checkout of the same repo reproduces that repo's
     AGENTS.md verbatim.
   - `horizonBefore` / `horizonAfter`: the sticky eviction horizon as
     read off the state and after the transform ran. Equal means the
     transform did not advance further on this turn.
   - `rawMessageCount` / `retainedMessageCount`: how many real
     transcript messages existed before the horizon and how many
     survived it. `retainedMessageCount === 0` is the starvation
     shape.
   - `dispatched`: the exact `AgentMessage[]` that would have been
     sent, including the two synthetic memory prepends.
   - `dispatchedHasRealUser`: `false` is the smoking gun — the model
     was asked to "continue the conversation" with no real user turn
     in scope.
   - `syntheticPrepends`: byte size + preview of the
     `observation-context` and `continuation-hint` user messages the
     transform injects from the durable pack.

5. **Lock the failure shape with an eval.** Write the failing assertions
   first (`retainedMessageCount === 0`, `dispatchedHasRealUser === false`,
   or whatever describes the bug). Use `testIfDocker`. The reference
   eval is `evals/session-compaction-wire-starvation.eval.ts` and the
   reference fixture pair is
   `evals/fixtures/session_VO5yjfS1vV6_/{state.json, memory-dump.json,
reproduce_and_diagnose.txt}`. The diagnose file is also a useful
   template — dump the empirical horizon, message counts, and rendered
   prepend sizes there before tuning the fix so you can see exactly
   what changed.

6. **Optional: live-model red/green eval.** When the bug is about
   what the MODEL produces from a degenerate wire shape (not just
   the shape itself), pair the wire-shape eval with a live-model
   eval that calls `complete()` from `@earendil-works/pi-ai` against
   `payload.systemPrompt` + `convertToLlm(payload.dispatched)` and
   grades the reply with a focused judge. Judge-the-judge against
   hand-crafted positive/negative replies before running it against
   the live model so a judge drift doesn't masquerade as a fix.
   `evals/session-compaction-continues-recent-work.eval.ts` plus
   `evals/continuation-judge.eval.ts` are the reference pair — the
   live eval is RED today and turns GREEN automatically once the
   wire-shaping fix lands.

For a quick read-only inspection without writing an eval, the same
helper works inline:

    bun -e 'import { readFile } from "node:fs/promises"; \
      import { capturedWirePayload } from "./evals/helpers/capture-wire-payload.js"; \
      const dir = "evals/fixtures/<session_id>"; \
      const { payload, dispose } = await capturedWirePayload({ \
        turnState: JSON.parse(await readFile(`${dir}/state.json`, "utf8")), \
        memoryDump: JSON.parse(await readFile(`${dir}/memory-dump.json`, "utf8")), \
        sessionId: "<session_id>", \
      }); console.log(payload); await dispose();'

## Tips

- The dump is read-only; you can run it while `duet` is open (it waits up to 60s on the cross-process open-lock).
- For a quick row count without writing JSON: `bun run scripts/dump-memory.ts --stats --limit 1 > /dev/null` prints the filtered + total row counts to stderr.
- If a memory bug only shows up live, capture the dump immediately — observations get superseded and the repro window closes.
- Keep fixtures small. A 30-row slice that reproduces is more useful than a 300-row pool that buries the signal.
