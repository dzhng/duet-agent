import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("task foreground budget conversion", () => {
  testIfDocker(
    "converts bash without aborting it",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        taskWaitBudgetMs: 50,
        skillDiscovery: { includeDefaults: false },
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      // Falsification target (Docker run pending): abort at budget expiry; the completed
      // settlement assertion must turn red.
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt:
            "Run `sleep 0.2 && printf FOREGROUND_DONE` with bash. Let the configured budget convert it; do not stop it. Confirm after it settles.",
        })
      ).turn;
      expect(terminal.type).toBe("complete");
      expect(events.some((event) => event.type === "task_started")).toBe(true);
      expect(
        events.some(
          (event) => event.type === "task_settled" && event.settlement.status === "completed",
        ),
      ).toBe(true);
      expect(JSON.stringify(terminal.state.agent.messages)).toContain("Task t1 is still running");
      await runner.dispose();
    },
    120_000,
  );
});
