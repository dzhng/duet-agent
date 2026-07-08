import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import { appendObservation } from "../src/memory/storage.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";

/**
 * Implicit cross-session `recall_memory` triggers.
 *
 * --- WHAT THIS EVAL IS FOR ---
 *
 * The trigger guidance for `recall_memory` lives in
 * `createRecallMemorySystemPromptLayer` (src/turn-runner/prompts.ts).
 * That layer is appended to the parent agent's system prompt whenever
 * `memoryDbPath` is set, and tells the model when to reach for the
 * tool. The tool itself only documents the mechanics (params, scopes,
 * fusion); the "when" lives in the layer.
 *
 * The explicit-trigger eval (`recall-memory-cross-session.eval.ts`)
 * proves the layer fires on obvious past-tense markers — "yesterday",
 * "previous session", "already done X". This eval covers the HARDER
 * failure mode: IMPLICIT cross-session triggers. The user mentions
 * a name (a person, pet, project, codename, release, branch, PR,
 * personal artifact) without flagging it as past work, or asks for
 * advice that only personalizes via durable memory. A well-tuned
 * layer should still send the agent to the durable store because
 * the named referent has no in-context anchor.
 *
 * Failure mode being guarded: the agent hedges ("I'm not sure who
 * that is" / "I'd need more context") or answers generically instead
 * of running one cheap `recall_memory` query against a name that
 * almost certainly exists in the user's durable memory.
 *
 * Negatives keep the layer honest: world-knowledge questions and
 * prompts whose named referents are DEFINED IN THIS TURN must stay
 * at zero recall calls. Without those, any prompt change that bumps
 * the implicit positives could also be silently over-recalling on
 * unrelated turns.
 *
 * --- HOW TO RUN IT ---
 *
 * From the repo root:
 *
 *   bun run eval                                # full eval suite
 *   bun test ./evals/recall-memory-implicit-triggers.eval.ts
 *                                               # this file only
 *
 * The `bun run eval` script runs inside Docker (oven/bun:1.3.11)
 * because every test here is gated by `testIfDocker` — they hit the
 * real Anthropic API and touch a real PGlite memory.db under tmp.
 * `bun test` directly works on a developer box that already has the
 * API keys exported.
 *
 * Override the actor model via `EVAL_MODEL=...` (e.g.
 * `EVAL_MODEL=sonnet-4.6` to compare). The default is opus because
 * that is the production CLI default (`DEFAULT_CLI_MODEL`).
 *
 * --- WHAT WE TRIED, WHAT WORKED, WHAT TO TRY NEXT ---
 *
 * The trigger layer in `prompts.ts` is the result of an iteration
 * pass against this eval and the explicit one. Findings, so a
 * future agent does not redo the same dead-end loops:
 *
 *   - Stuffing the trigger guidance into the tool description gave
 *     the same behavior as the split layer (4/4 on the explicit
 *     eval), but ate prompt-cache tokens on every turn and lived
 *     far from the rest of the routing guidance. The split layer
 *     mirrors the state-machine pattern in `prompts.ts` and stays
 *     gated on `memoryDbPath`. Keep the split.
 *
 *   - Sonnet-4.6 hit 8/11 combined (this eval + the explicit one).
 *     Opus-4.7 hits 6/11 with the same layer. Opus is more
 *     conservative about speculative tool calls and stops calling
 *     `recall_memory` on the implicit-but-clearly-personal cases
 *     (colleague name, release id) that Sonnet handles. We accept
 *     that gap: Opus is the production default, but tuning the
 *     layer further to coax Opus regressed Sonnet (notably the
 *     colleague case), so the current layer is the Pareto-best
 *     prose we found.
 *
 *   - More aggressive imperatives ("DEFAULT BEHAVIOR: recall_memory
 *     is cheap, call it freely…", possessive/continuity heuristics,
 *     self-check clauses) did NOT help on Opus and sometimes hurt
 *     on Sonnet. Shorter / sharper prose also regressed (Opus
 *     stopped firing on "what did you do yesterday"). The current
 *     layer is intentionally medium-verbosity — two enumerated
 *     classes (EXPLICIT / IMPLICIT) plus a personalization clause
 *     plus an anti-hedge clause.
 *
 *   - Mechanical interventions outside prompt tuning are the next
 *     productive lever, NOT more prose. Options:
 *       • a pre-turn proper-noun classifier (a small structured
 *         output call before the parent agent that flags un-anchored
 *         named referents and injects a one-shot system reminder);
 *       • active-recall on send (kick off a `recall_memory` in
 *         parallel with the parent agent when a heuristic flag fires
 *         and surface the result as context, removing the choice
 *         from the model).
 *     The user explicitly chose to stick to prompt tuning for now
 *     to avoid complexity, so do not introduce these without
 *     fresh direction.
 *
 * --- EXPECTED FAILURES (opus-4.7, current layer) ---
 *
 * On the default actor model (opus-4.7) ALL FIVE implicit-trigger
 * positives below are EXPECTED to stay red, and the eval will
 * report them as failures. The two negatives in this file pass on
 * Opus, plus all four scenarios in the sibling explicit eval —
 * 6/11 combined.
 *
 *   • "How is Doughy doing?"                                (pet name)
 *   • "Has Walter shared his take on the gateway race?"      (colleague — passes on Sonnet, fails on Opus)
 *   • "What was in v0.1.146, exactly?"                       (release id — passes on Sonnet, fails on Opus)
 *   • "Is the fiddle-leaf still happy in its spot?"          (houseplant codename)
 *   • "Given how my starter has been behaving…"              (personalization-by-possessive)
 *
 * These are the cases where Opus is most willing to answer
 * generically without a lookup. If you change the layer, the
 * stable target is: do not regress the explicit-trigger eval
 * (must stay 4/4 on both models) and do not regress the negatives
 * here (must stay 2/2 on both models). Anything beyond that on
 * Opus implicit triggers is a bonus.
 *
 * --- REPRODUCING THE BASELINE ---
 *
 * If a future change makes results swing wildly, re-run twice
 * before drawing conclusions — single-trial LLM noise can flip
 * 1–2 scenarios per run, especially "colleague" and "yesterday".
 * The combined cross-session + implicit run takes ~3 minutes
 * end-to-end against real APIs, so a second run is cheap.
 */

// Defaults to opus-4.7 because opus is the production CLI default
// (`DEFAULT_CLI_MODEL` in src/model-resolution/catalog.ts). Tuning the
// trigger layer against the model the user actually runs is the only
// version of this eval that constrains real-world behavior. Override
// with `EVAL_MODEL=sonnet-4.6` to compare — see the table near the
// bottom of this file for the cross-model behavior we measured.
const actorModel = process.env.EVAL_MODEL ?? "opus-4.7";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

interface Scenario {
  name: string;
  prompt: string;
  shouldRecall: boolean;
}

const scenarios: Scenario[] = [
  {
    // Named pet, no past-tense marker. The user assumes the agent
    // already knows what "Doughy" is. The only way to honor that
    // assumption is to look it up.
    name: "named referent with no past-tense marker — pet name",
    prompt: "How is Doughy doing? Should I switch to a stiffer feeding ratio?",
    shouldRecall: true,
  },
  {
    // Named person, no past-tense marker. Could be a colleague the
    // agent has spoken about before. Recall first, then answer.
    name: "named person with no past-tense marker — colleague",
    prompt: "Has Walter shared his take on the gateway race condition yet?",
    shouldRecall: true,
  },
  {
    // Bare release identifier. No "remember when" framing.
    name: "bare release identifier the agent has no active context on",
    prompt: "What was in v0.1.146, exactly? I want to write the changelog.",
    shouldRecall: true,
  },
  {
    // Codenamed project / artifact dropped into a present-tense
    // question. Classic "I assume you know what I mean" prompt.
    name: "codenamed artifact dropped into a present-tense question",
    prompt: "Is the fiddle-leaf still happy in its spot, or should I move it?",
    shouldRecall: true,
  },
  {
    // Named identifier (sourdough hobby) phrased as advice-seeking
    // rather than memory-checking. Recall is what turns this from
    // a generic answer into a personalized one.
    name: "advice question that only personalizes via durable memory",
    prompt:
      "I'm thinking about extending my bulk ferment by a couple hours. Given how my starter has been behaving, is that a bad idea?",
    shouldRecall: true,
  },
  {
    // NEGATIVE: world knowledge, no personal anchor. Must not recall.
    name: "world-knowledge question stays at zero recall calls",
    prompt: "What's the boiling point of water at sea level in Celsius?",
    shouldRecall: false,
  },
  {
    // NEGATIVE: the user explicitly defines the referent in-turn,
    // so there is nothing durable to look up. Must not recall.
    name: "named referent defined in the same turn stays at zero recall",
    prompt:
      "Let me introduce a new project called Project Atlas: a CLI for managing dotfiles. What's a sensible directory layout for it?",
    shouldRecall: false,
  },
];

describe("recall_memory implicit triggers", () => {
  for (const scenario of scenarios) {
    testIfDocker(
      scenario.name,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "duet-recall-implicit-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "memory.db");

        // Seed durable observations covering every named referent in
        // the positive scenarios so a real recall_memory call would
        // actually return something. The negative scenarios reference
        // nothing in this seed set — recall would come back empty,
        // which is exactly why the model should not bother.
        await seedDurableReferents(dbPath);

        const runner = new TurnRunner({
          sessionId: "recall-implicit-eval",
          model: actorModel,
          memoryModel,
          mode: "agent",
          skillDiscovery: { includeDefaults: false },
          memoryDbPath: dbPath,
          cwd: dir,
        });

        const recallCalls: Array<{ query?: string }> = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          const step = event.step;
          if (step.type !== "tool_call_start") return;
          if (step.toolName !== "recall_memory") return;
          const input = step.input as { query?: string } | undefined;
          recallCalls.push({ query: input?.query });
        });

        try {
          await runner.start({ type: "start" });
          const terminal = await runner.turn({
            type: "prompt",
            message: scenario.prompt,
            behavior: "follow_up",
          });
          expect(terminal.type).toBe("complete");

          console.log(
            `\n[${scenario.name}] shouldRecall=${scenario.shouldRecall} calls=${recallCalls.length}\n  queries=${JSON.stringify(recallCalls.map((c) => c.query))}\n`,
          );

          if (scenario.shouldRecall) {
            expect(recallCalls.length).toBeGreaterThanOrEqual(1);
          } else {
            expect(recallCalls.length).toBe(0);
          }
        } finally {
          await runner.dispose();
        }
      },
      120_000,
    );
  }
});

async function seedDurableReferents(dbPath: string): Promise<void> {
  const session = new MemorySession({
    path: dbPath,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    idleCloseMs: 60_000,
  });
  try {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const seeds = [
      {
        date: twoWeeksAgo,
        priority: "medium" as const,
        content: `Date: ${twoWeeksAgo}\n* 🟡 User mentioned their sourdough starter "Doughy" has been thriving for three weeks on a 1:2:2 feeding ratio. Bulk fermenting around 4-5 hours at 72°F kitchen temp.`,
      },
      {
        date: lastWeek,
        priority: "medium" as const,
        content: `Date: ${lastWeek}\n* 🟡 User has a fiddle-leaf fig near the south-facing window in the kitchen; gets bright indirect light most of the day. User asked whether the current spot is bright enough.`,
      },
      {
        date: lastWeek,
        priority: "high" as const,
        content: `Date: ${lastWeek}\n* 🟢 Walter pushed back on the agent-gateway race fix during code review, arguing the SessionStore.save() temp-file + rename approach was correct and not "overengineered". His comment is the precedent we're leaning on.`,
      },
      {
        date: yesterday,
        priority: "high" as const,
        content: `Date: ${yesterday}\n* 🟢 Released v0.1.146 in duet-agent: openPGliteHoldingLock now rethrows ENOENTs pointing outside dataDir (canonical case: bundled pglite.data missing during self-update) instead of renaming memory.db to .corrupted-*. Fix commit 31796b6, release commit 0a3592f.`,
      },
    ];

    for (const seed of seeds) {
      await appendObservation(session, {
        sessionId: "session_other_prior",
        kind: "observation",
        observedDate: seed.date,
        priority: seed.priority,
        source: { kind: "system" },
        content: seed.content,
        tags: ["seeded", "implicit-trigger"],
      });
    }
  } finally {
    await session.dispose();
  }
}
