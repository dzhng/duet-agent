import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("scheduled-only quiescence", () => {
  testIfDocker(
    "returns sleep when only a durable timer remains",
    async () => {
      const runner = new TurnRunner(
        { model, mode: "auto", skillDiscovery: { includeDefaults: false } },
        { minimumScheduledDelayMs: 50 },
      );
      // Falsification target (Docker run pending): classify scheduled descriptors as open;
      // the strict sleep assertion must turn red or time out.
      const terminal = await (
        await startTurn(runner, {
          mode: "auto",
          prompt: dedent`
        Planning-only eval. Create a state machine with a timer state named wait that wakes 2 seconds from now and a completed terminal named eval_done. Wire wait as firstState. Do not call bash.
      `,
        })
      ).turn;
      expect(terminal.type).toBe("sleep");
      expect(terminal.state.tasks).toMatchObject([{ kind: "scheduled", status: "scheduled" }]);
      await runner.dispose();
    },
    120_000,
  );
});
