import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import { DEFAULT_CLI_MEMORY_MODEL, resolveModelName } from "../src/model-resolution/resolver.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

// Three distinct models contribute to one turn: the orchestrating parent
// runner, a sub-agent state pinned to a different model, and the memory
// observer. The eval proves all three surface in `usageByModel`, mirroring
// the user's case ("run with glm, sub-agent uses sonnet, plus the memory
// model"). Keep the parent and state models distinct so the attribution is
// unambiguous; the memory model defaults to the luna observer.
const parentModel = process.env.EVAL_MODEL ?? "glm-4.7";
const stateModel = parentModel === "sonnet-4.6" ? "haiku-4.5" : "sonnet-4.6";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

let tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/**
 * End-to-end proof that a turn's per-model usage breakdown folds in every
 * model boundary the runner drives: the parent orchestrator, a state-machine
 * sub-agent pinned to a different model, and the memory observer. A
 * regression that dropped any one attribution — e.g. the state-agent
 * `recordUsage` call at the sub-agent boundary, or the memory observer's
 * `onUsage` callback — would shrink `usageByModel` below three entries or
 * drop the missing model's slug.
 */
describe("state machine usage by model", () => {
  testIfDocker(
    "attributes parent, sub-agent, and memory usage to distinct usageByModel entries",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-usage-by-model-eval-"));
      tempDirs.push(tempDir);

      const manager = new SessionManager(
        {
          model: parentModel,
          memoryModel,
          cwd: tempDir,
          memoryDbPath: join(tempDir, "memory.db"),
          mode: usageDefinition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is an eval. Use the provided state machine to run the workflow.",
            "Select states in this order: record_fact, eval_done.",
            "Do not ask the user questions.",
          ].join("\n"),
        },
        { sessionStoragePath: join(tempDir, "sessions") },
      );

      const events: TurnEvent[] = [];
      try {
        const session = manager.create({ mode: usageDefinition });
        session.subscribe((event) => events.push(event));

        // A high-signal durable fact so the observer extracts an observation
        // and makes a real LLM call attributed to the memory model.
        await session.prompt({
          message:
            "My name is Priya and I keep my fiddle-leaf fig in the north-facing window. " +
            "Run the eval workflow.",
        });
        const terminal = await session.waitForTerminal();

        expect(terminal.type).toBe("complete");
        if (terminal.type !== "complete") throw new Error("expected complete");

        const usageByModel = terminal.usageByModel;
        expect(usageByModel).toBeDefined();

        const parentId = resolveModelName(parentModel).id;
        const stateId = resolveModelName(stateModel).id;
        // Every boundary — parent, sub-agent, and memory observer — attributes
        // usage by resolved model id, so all three entries are resolved slugs.
        const memoryId = resolveModelName(memoryModel).id;
        const models = usageByModel!.map((entry) => entry.model);

        // All three boundaries attributed their own model, with no collisions.
        expect(new Set(models).size).toBe(models.length);
        expect(models).toContain(parentId);
        expect(models).toContain(stateId);
        expect(models).toContain(memoryId);
        expect(usageByModel!.length).toBeGreaterThanOrEqual(3);

        // Every entry carries real, positive usage — no zero-token placeholders.
        for (const entry of usageByModel!) {
          expect(entry.usage.totalTokens).toBeGreaterThan(0);
          expect(entry.usage.cost.total).toBeGreaterThanOrEqual(0);
        }

        // Core invariant: per-model cost totals reconstruct the turn total.
        expect(terminal.turnUsage).toBeDefined();
        const summed = usageByModel!.reduce((acc, entry) => acc + entry.usage.cost.total, 0);
        expect(summed).toBeCloseTo(terminal.turnUsage!.cost.total, 6);
        const summedTokens = usageByModel!.reduce((acc, entry) => acc + entry.usage.totalTokens, 0);
        expect(summedTokens).toBe(terminal.turnUsage!.totalTokens);
      } finally {
        await manager.dispose();
      }
    },
    180_000,
  );
});

const usageDefinition: StateMachineDefinition = {
  name: "usage_by_model_eval",
  prompt:
    "Use this state machine to run a one-step eval. Pick record_fact, then the terminal eval_done. Do not call tools inside agent states.",
  states: [
    {
      kind: "agent",
      name: "record_fact",
      // Pinned to a different model than the parent so the sub-agent's usage
      // lands under its own `usageByModel` entry. This is the UI-only model
      // override, set directly on the definition exactly as the UI writes it.
      model: stateModel,
      prompt:
        "Do not call tools. Write a single short sentence confirming the eval ran. Reply with the sentence only.",
    },
    {
      kind: "terminal",
      name: "eval_done",
      status: "completed",
      reason: "The fact was recorded.",
    },
  ],
};
