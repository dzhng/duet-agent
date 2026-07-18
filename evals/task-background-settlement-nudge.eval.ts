import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("background settlement nudge", () => {
  testIfDocker(
    "re-prompts with one B3 reminder",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });
      // Falsification target (Docker run pending): drop enqueueAvailableSettlements; the B3
      // reminder assertion must turn red.
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt:
            "Run `sleep 0.2 && printf BACKGROUND_DONE` with bash using run_in_background=true. Wait for the settlement nudge, then finish.",
        })
      ).turn;
      const transcript = JSON.stringify(terminal.state.agent.messages);
      expect(transcript).toContain("Started background task");
      expect(transcript).toContain("task settled while you were working");
      expect(transcript.match(/task settled while you were working/g)?.length).toBe(1);
      await runner.dispose();
    },
    120_000,
  );
});
