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
 * Cross-session recall_memory tool usage.
 *
 * When the user references work from another session — "what did
 * you do yesterday", "you've already done X right?", "did we ship
 * Y in the previous session?" — the agent must reach for the
 * `recall_memory` tool to look up the durable cross-session pool.
 * The rendered observations block in the system prompt only carries
 * the highest-signal reflections; everything else lives in the
 * durable store and is only visible through `recall_memory`.
 *
 * The failure mode this eval guards against is the agent answering
 * from the rendered observation summary alone (or worse, "I don't
 * remember") when a tool call would have returned the actual
 * answer. The assertion is intentionally narrow: at least one
 * `recall_memory` tool call must be attempted on cross-session
 * questions, and zero on prompts that are obviously self-contained.
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
  /**
   * Whether the model is expected to invoke `recall_memory` before
   * answering. Positive scenarios are cross-session lookups; the
   * negative scenario is a self-contained arithmetic prompt that
   * has nothing to do with durable memory.
   */
  shouldRecall: boolean;
}

const scenarios: Scenario[] = [
  {
    name: "asking what was done yesterday triggers recall_memory",
    prompt: "What did you do yesterday?",
    shouldRecall: true,
  },
  {
    name: "checking whether something was already done triggers recall_memory",
    prompt:
      "You've already wired up the staging CI green loop for the agent gateway, right? Can you confirm what we landed before I start a new branch?",
    shouldRecall: true,
  },
  {
    name: "asking about work from another session triggers recall_memory",
    prompt: "In a previous session we picked a model for fast:google — which one did we go with?",
    shouldRecall: true,
  },
  {
    name: "self-contained arithmetic does not trigger recall_memory",
    prompt: "What is 2 + 2? Reply with just the number.",
    shouldRecall: false,
  },
];

describe("recall_memory cross-session usage", () => {
  for (const scenario of scenarios) {
    testIfDocker(
      scenario.name,
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "duet-recall-cross-session-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "memory.db");

        // Seed durable observations on unrelated topics from a
        // *different* session id. The rendered cross-session block
        // will therefore not contain the answer to the scenario
        // prompt — the only way to honor the user's cross-session
        // question is to actually call recall_memory. Without seeds
        // the model can shortcut by deciding the store is obviously
        // empty; the seeds make the store look populated but with
        // unrelated content, so a real lookup is the only honest path.
        await seedCrossSessionMemory(dbPath);

        const runner = new TurnRunner({
          sessionId: "recall-cross-session-eval",
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

async function seedCrossSessionMemory(dbPath: string): Promise<void> {
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
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Topics intentionally unrelated to every scenario prompt: a
    // sourdough hobby thread and a houseplant note. They give the
    // store enough signal that the rendered global pack looks alive
    // without leaking any answer that overlaps with the eval prompts.
    const seeds = [
      {
        content: `Date: ${lastWeek}\n* 🟡 User mentioned their sourdough starter ("Doughy") has been thriving for three weeks on a 1:2:2 feeding ratio.`,
        priority: "medium" as const,
      },
      {
        content: `Date: ${lastWeek}\n* 🟡 User asked about light requirements for a fiddle-leaf fig they keep near the south-facing window in the kitchen.`,
        priority: "medium" as const,
      },
    ];
    for (const seed of seeds) {
      await appendObservation(session, {
        sessionId: "session_other_prior",
        kind: "observation",
        observedDate: lastWeek,
        priority: seed.priority,
        source: { kind: "system" },
        content: seed.content,
        tags: ["seeded", "cross-session"],
      });
    }
  } finally {
    await session.dispose();
  }
}
