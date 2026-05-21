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

/**
 * Implicit cross-session recall_memory triggers.
 *
 * The explicit-trigger eval (`recall-memory-cross-session.eval.ts`)
 * proves the model reaches for `recall_memory` when the user uses
 * obvious past-tense markers — "yesterday", "previous session",
 * "already done X". The much harder failure mode is the IMPLICIT
 * case: the user names a person, project, branch, PR, bug, pet,
 * commitment, or codename the agent has no active context on, and
 * does NOT flag it as past work. A well-tuned trigger layer should
 * still send the agent to the durable store because the named
 * referent has no in-context anchor.
 *
 * The failure mode this eval guards against is the agent inventing
 * a hedge ("I'm not sure who that is" / "I don't have details on
 * that branch") instead of running a single recall_memory query
 * against a name that almost certainly exists in the user's
 * durable memory.
 *
 * Negatives: world-knowledge questions, math, and prompts whose
 * named referents are part of the active conversation (the user
 * just defined "Project Atlas" in this turn) must stay at zero
 * recall calls so the layer does not bias toward over-recall.
 */

const actorModel = process.env.EVAL_MODEL ?? "sonnet-4.6";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? "haiku-4.5";

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
          if (step.type !== "tool_call") return;
          if (step.toolName !== "recall_memory") return;
          if (step.status !== "running") return;
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
