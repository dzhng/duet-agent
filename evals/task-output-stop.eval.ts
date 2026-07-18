import { describe, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("task output and stop", () => {
  testIfDocker(
    "reads buffered output and stops the process group",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-task-stop-"));
      const paths = Object.fromEntries(
        ["started", "pid", "release", "stopped"].map((name) => [name, join(dir, name)]),
      );
      const command = `bun evals/fixtures/task-work.ts --started-file ${paths.started} --pid-file ${paths.pid} --release-file ${paths.release} --stopped-file ${paths.stopped} --stdout BUFFERED_SENTINEL --stderr STDERR_SENTINEL`;
      const runner = new TurnRunner({
        model,
        mode: "agent",
        cwd: process.cwd(),
        skillDiscovery: { includeDefaults: false },
      });
      const calls: string[] = [];
      const taskOutputResults: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        if (event.step.type === "tool_call_start") calls.push(event.step.toolName);
        if (event.step.type === "tool_call" && event.step.toolName === "task_output") {
          taskOutputResults.push(JSON.stringify(event.step.output));
        }
      });
      // Falsification targets (Docker run pending): source task_output from transcript, then
      // omit process-group abort; the buffered-output and stopped-marker checks must turn red.
      await (
        await startTurn(runner, {
          mode: "agent",
          prompt: `Run this exact command in background: \`${command}\`. Then call task_output for its id, verify BUFFERED_SENTINEL, and call task_stop.`,
        })
      ).turn;
      expect(calls).toContain("task_output");
      expect(calls).toContain("task_stop");
      expect(taskOutputResults.join("\n")).toContain("BUFFERED_SENTINEL");
      expect(await readFile(paths.stopped!, "utf8")).toContain("SIGTERM");
      await runner.dispose();
    },
    120_000,
  );
});
