import { describe, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnState, TurnTerminalEvent } from "../src/types/protocol.js";
import type {
  StateMachineDefinition,
  StateMachineSessionEvent,
} from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("state machine agent state cwd", () => {
  testIfDocker(
    "runs a sub-agent in a different working directory via state.cwd",
    async () => {
      const parentDir = await mkdtemp(join(tmpdir(), "sm-cwd-parent-"));
      const agentDir = await mkdtemp(join(tmpdir(), "sm-cwd-agent-"));
      const sentinel = "CWD_EVAL_SENTINEL_42";
      try {
        // Sentinel file lives only in agentDir. If the sub-agent inherits
        // parentDir from the runner config, `cat sentinel.txt` fails.
        await writeFile(join(agentDir, "sentinel.txt"), sentinel);

        const definition: StateMachineDefinition = {
          name: "agent_cwd_eval",
          prompt:
            "Validate that an agent state's cwd field scopes its coding tools to that directory.",
          states: [
            {
              kind: "agent",
              name: "read_sentinel",
              cwd: agentDir,
              prompt: [
                "Call the bash tool with command `cat sentinel.txt` and no cwd argument.",
                "Then reply with exactly the file contents and nothing else.",
              ].join("\n"),
            },
            {
              kind: "terminal",
              name: "done",
              status: "completed",
              reason: "Agent cwd eval completed.",
            },
          ],
        };

        const runner = new TurnRunner({
          model,
          cwd: parentDir,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          systemInstructions: [
            "This is a live eval. Use select_state_machine_state for every transition.",
            "Do not override the agent state's cwd; rely on the definition value.",
            "On the initial prompt, select read_sentinel without input.",
            "After read_sentinel completes, select done.",
          ].join("\n"),
        });

        const started = await startTurn(runner, {
          mode: definition,
          prompt: "Start the agent cwd eval.",
        });
        const terminal = await started.turn;

        expectCompleted(terminal);
        expect(terminal.state.stateMachine?.terminal).toMatchObject({
          state: "done",
          status: "completed",
        });
        expect(completedOutput(terminal.state, "read_sentinel")).toContain(sentinel);
      } finally {
        await Promise.all([
          rm(parentDir, { recursive: true, force: true }),
          rm(agentDir, { recursive: true, force: true }),
        ]);
      }
    },
    150_000,
  );
});

function expectCompleted(event: TurnTerminalEvent): void {
  expect(event.type).toBe("complete");
  expect(event.type === "complete" ? event.status : undefined).toBe("completed");
}

function completedOutput(state: TurnState, selectedState: string): string {
  const history = state.stateMachine?.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index] as StateMachineSessionEvent;
    if (event.type === "state_completed" && event.state === selectedState) {
      const output = event.output;
      if (
        output &&
        typeof output === "object" &&
        "result" in output &&
        typeof output.result === "string"
      ) {
        return output.result;
      }
      return output === undefined ? "" : JSON.stringify(output);
    }
  }
  throw new Error(`Expected state_completed for ${selectedState}`);
}
