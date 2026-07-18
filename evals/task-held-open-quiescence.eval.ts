import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("held-open quiescence", () => {
  testIfDocker(
    "emits its first terminal strictly after final settlement",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });
      const order: string[] = [];
      runner.subscribe((event: TurnEvent) => order.push(event.type));
      // Falsification target (Docker run pending): complete after the first parent pass; the
      // event-order assertion must turn red.
      await (
        await startTurn(runner, {
          mode: "agent",
          prompt:
            "Start `sleep 0.2 && printf QUIESCENT` in the background with bash, then wait for it and finish.",
        })
      ).turn;
      expect(
        order.filter((type) => ["ask", "complete", "interrupted", "sleep"].includes(type)),
      ).toEqual(["complete"]);
      expect(order.indexOf("task_settled")).toBeLessThan(order.indexOf("complete"));
      await runner.dispose();
    },
    120_000,
  );
});
