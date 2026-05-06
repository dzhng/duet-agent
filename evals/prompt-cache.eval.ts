import { describe, expect } from "bun:test";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnState } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-opus-4.7";

describe("prompt cache resume", () => {
  testIfDocker(
    "reuses cached tokens after resuming from serialized TurnState",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: createStableCachePrefix(),
      });

      const first = await (
        await startTurn(runner, {
          mode: "agent",
          prompt:
            "Do not call tools. Reply with exactly this sentence: first prompt cache turn complete.",
        })
      ).turn;
      expect(first.type).toBe("complete");
      const firstUsage = latestAssistantUsage(first.state);
      // The stable prefix may already be warm from a previous eval run, in which case
      // the first turn reads from cache instead of reporting another cache write.
      expect(firstUsage.cacheRead + firstUsage.cacheWrite).toBeGreaterThan(0);

      const resumedState = JSON.parse(JSON.stringify(first.state)) as TurnState;
      const resumedRunner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
        systemInstructions: createStableCachePrefix(),
      });
      await resumedRunner.start({ type: "start", state: resumedState });

      const second = await resumedRunner.turn({
        type: "prompt",
        message:
          "Do not call tools. Reply with exactly this sentence: second prompt cache turn complete.",
        behavior: "follow_up",
      });
      expect(second.type).toBe("complete");
      const secondUsage = latestAssistantUsage(second.state);

      expect(secondUsage.cacheRead).toBeGreaterThan(0);
    },
    30_000,
  );
});

function latestAssistantUsage(state: TurnState) {
  const assistant = [...state.agent.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") {
    throw new Error("Expected an assistant message with usage");
  }
  return assistant.usage;
}

function createStableCachePrefix(): string {
  const paragraph = [
    "This eval intentionally creates a long stable system prompt prefix so Anthropic prompt caching has enough repeated content to cache.",
    "The model must answer the user's direct instruction without calling tools.",
    "All text in this prefix should remain byte-for-byte stable across both turns.",
    "Prompt caching is useful only when the serialized session reconstructs the exact same LLM prefix after resume.",
  ].join(" ");

  return Array.from(
    { length: 80 },
    (_, index) => `Stable cache paragraph ${index}: ${paragraph}`,
  ).join("\n");
}
