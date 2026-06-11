import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { StateMachineController } from "../src/turn-runner/state-machine-controller.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Regression coverage for the script/poll output cap.
 *
 * A state that pipes a whole test log or build transcript back through stdout
 * used to be inlined verbatim into the orchestrator's state-completion wake
 * prompt. A 100KB+ log bloated the decision turn to tens of thousands of
 * tokens, which both wasted context and made the decision request fragile
 * enough to abort and loop until the machine force-terminated. The controller
 * now caps each output stream, writes the full stream to a file under the OS
 * temp dir, and points the orchestrator at that file.
 */
describe("script/poll output cap", () => {
  testIfDocker(
    "caps oversized script stdout and writes the full output to a recoverable file",
    async () => {
      // ~90k characters of unique-per-line content (well over the cap) so we
      // can prove the full output survived on disk while the inlined value was
      // truncated.
      const lineCount = 5_000;
      const command = `for i in $(seq 1 ${lineCount}); do echo "duet-cap-line-$i"; done`;
      const definition: StateMachineDefinition = {
        name: "oversized_output",
        prompt: "Run.",
        states: [
          { kind: "script", name: "emit", command },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      };
      const controller = createController();
      controller.startSession({ prompt: "Run.", definition, currentState: "emit" });

      const result = await controller.runDecision({ state: "emit" });
      expect(result.type).toBe("state_completed");
      if (result.type !== "state_completed") return;

      const output = result.output as { stdout: string; parsed: { result?: string } };

      // The inlined stdout is bounded and no longer carries the whole log.
      expect(output.stdout.length).toBeLessThan(20_000);
      expect(output.stdout).toContain("duet-cap-line-1");
      expect(output.stdout).toContain(`duet-cap-line-${lineCount}`);
      expect(output.stdout).toContain("truncated for the orchestrator");

      // The pointer references a real file that holds the complete, untruncated
      // output (head, tail, and the middle the prompt dropped).
      const pathMatch = output.stdout.match(/written to (\S+\.log)/);
      expect(pathMatch).not.toBeNull();
      const overflowPath = pathMatch![1];
      expect(existsSync(overflowPath)).toBe(true);
      const fullOutput = readFileSync(overflowPath, "utf8");
      for (const i of [1, lineCount / 2, lineCount]) {
        expect(fullOutput).toContain(`duet-cap-line-${i}`);
      }

      // The non-JSON `parsed.result` fallback must reuse the capped string
      // rather than smuggling the firehose back through `parsed`.
      expect(output.parsed.result).toBe(output.stdout);
    },
  );

  testIfDocker("leaves small stdout untouched", async () => {
    const definition: StateMachineDefinition = {
      name: "small_output",
      prompt: "Run.",
      states: [
        { kind: "script", name: "emit", command: "printf duet-small-output" },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController();
    controller.startSession({ prompt: "Run.", definition, currentState: "emit" });

    const result = await controller.runDecision({ state: "emit" });
    expect(result.type).toBe("state_completed");
    if (result.type !== "state_completed") return;
    expect(result.output).toMatchObject({ stdout: "duet-small-output" });
  });
});

function createController(): StateMachineController {
  return new StateMachineController({
    cwd: process.cwd(),
    createStateAgent: () => {
      throw new Error("Agent state should not be invoked in output-cap tests.");
    },
  });
}
