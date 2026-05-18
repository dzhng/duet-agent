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

## Keep prompt examples independent from eval fixtures

When you tune a memory prompt to make an eval pass, write the worked examples in the prompt with content from a DIFFERENT domain than the fixture. A prompt example that mirrors the fixture is teaching the model to pattern-match the test, not the rule.

Concrete rules:

- Mix domains across the worked examples in the same prompt. Some can be dev (backend conventions, lint config, commit format) — those generalize well — but not all of them. At least one example should sit outside engineering: a hiring rubric, an OKR plan, a household routine, a travel itinerary, an interview scorecard.
- Don't mirror the fixture content. If the fixture is about release commits and CI gateway races, the prompt examples shouldn't also be about release commits and CI gateway races. Pick a different work area (conventions, onboarding, hiring) or step outside work entirely.
- The fixture proves the rule holds on the real data shape the user actually has. The prompt examples teach the rule abstractly. They're complementary, not parallel.
- When you catch yourself reusing fixture phrasing in a prompt (a specific commit SHA, a specific PR number, a verbatim error string from the fixture), stop and rewrite it.

This matters because observational memory runs over every kind of user content — not just code. A prompt that only ever shows dev-shaped examples will under-perform on a hiring, planning, or personal turn.

## Tips

- The dump is read-only; you can run it while `duet` is open (it waits up to 60s on the cross-process open-lock).
- For a quick row count without writing JSON: `bun run scripts/dump-memory.ts --stats --limit 1 > /dev/null` prints the filtered + total row counts to stderr.
- If a memory bug only shows up live, capture the dump immediately — observations get superseded and the repro window closes.
- Keep fixtures small. A 30-row slice that reproduces is more useful than a 300-row pool that buries the signal.
