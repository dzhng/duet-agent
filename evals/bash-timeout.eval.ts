import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { DEFAULT_BASH_TIMEOUT_SECONDS } from "../src/turn-runner/tools.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

interface BashCall {
  command: string;
  timeout: number | undefined;
}

describe("bash tool timeout", () => {
  testIfDocker(
    "model passes an explicit timeout for commands that need longer than the default cap",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      const bashCalls: BashCall[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.toolName !== "bash") return;
        if (step.status !== "running") return;
        const input = step.input as { command?: string; timeout?: number } | undefined;
        bashCalls.push({
          command: input?.command ?? "",
          timeout: typeof input?.timeout === "number" ? input.timeout : undefined,
        });
      });

      // The actual command finishes in ~1s, but the prompt frames it as a
      // long-running build so the model has to read the system-prompt guidance
      // ("pass an explicit `timeout` argument sized to the expected runtime")
      // and pass a timeout that won't be killed by the default 5-minute cap.
      const expectedMinTimeout = DEFAULT_BASH_TIMEOUT_SECONDS + 60;
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
            Run this command for me: \`sleep 1 && echo build-finished\`.

            Treat it as a stand-in for a slow project build that we expect to take roughly 15 minutes end-to-end. Pick the bash timeout argument so the build will not be killed prematurely. Once it finishes, just confirm it ran.
          `,
        })
      ).turn;

      expect(terminal.type).toBe("complete");

      const longRunningCall = bashCalls.find((call) => call.command.includes("sleep"));
      expect(
        longRunningCall,
        `expected a bash call for the build; saw ${JSON.stringify(bashCalls)}`,
      ).toBeDefined();
      if (!longRunningCall) throw new Error("unreachable");

      expect(
        longRunningCall.timeout,
        `expected an explicit timeout >= ${expectedMinTimeout}s; saw ${longRunningCall.timeout}`,
      ).toBeGreaterThanOrEqual(expectedMinTimeout);
    },
    120_000,
  );
});
