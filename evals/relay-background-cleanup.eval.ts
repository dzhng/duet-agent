import { describe, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

describe("relay background cleanup", () => {
  testIfDocker(
    "parent cleans up a worker's preview process before advancing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "relay-preview-"));
      const command = `bun ${join(process.cwd(), "evals/fixtures/task-work.ts")} --started-file ${dir}/started --pid-file ${dir}/pid --release-file ${dir}/release --stopped-file ${dir}/stopped --stdout PREVIEW_READY --stderr none`;
      const definition: StateMachineDefinition = {
        name: "Preview cleanup",
        prompt: "Preview, clean up temporary work, then finish.",
        states: [
          {
            kind: "agent",
            name: "preview",
            allowedSkills: [],
            prompt: dedent`
            Run this exact preview process with bash and run_in_background=true:
            ${command}
            Return PREVIEW_CHECK_FINISHED once it starts. Leave the process for the
            parent to manage; do not wait for or stop it yourself. This is your entire task.
          `,
          },
          { kind: "terminal", name: "done", status: "completed" },
        ],
      };
      const runner = new TurnRunner({
        model,
        mode: definition,
        cwd: dir,
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: dedent`
        Run the preview state once, then finish at done. The preview process is
        temporary and is unnecessary after the worker returns. Follow runtime
        task-management reminders. Do not launch extra workers or shell commands.
      `,
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await runner.start({ type: "start", mode: definition });
        const terminal = await Promise.race([
          runner.turn({
            type: "prompt",
            message: "Run the preview workflow.",
            behavior: "follow_up",
          }),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error("Relay did not finish after its preview worker returned")),
              90_000,
            );
          }),
        ]);
        expect(terminal.type).toBe("complete");
        expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
        const server = events.find(
          (e) =>
            e.type === "task_started" &&
            e.task.kind === "tool" &&
            e.task.label.includes("task-work.ts"),
        );
        if (!server || server.type !== "task_started")
          throw new Error("Preview process never started");
        const workerDone = events.findIndex(
          (e) =>
            e.type === "task_settled" &&
            e.settlement.status === "completed" &&
            e.settlement.id !== server.task.id,
        );
        const stop = events.findIndex(
          (e) =>
            e.type === "step" &&
            !e.origin &&
            e.step.type === "tool_call_start" &&
            e.step.toolName === "task_stop" &&
            e.step.input?.id === server.task.id,
        );
        const stopped = events.findIndex(
          (e) =>
            e.type === "task_settled" &&
            e.settlement.id === server.task.id &&
            e.settlement.status === "stopped",
        );
        const done = events.findIndex(
          (e) => e.type === "state_machine" && e.stateMachine.currentState === "done",
        );
        expect(workerDone).toBeGreaterThan(-1);
        expect(stop).toBeGreaterThan(workerDone);
        expect(stopped).toBeGreaterThan(stop);
        expect(done).toBeGreaterThan(stopped);
        const pid = Number(await readFile(join(dir, "pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } catch (error) {
        console.error(
          "RELAY_CLEANUP_EVIDENCE",
          JSON.stringify(
            events.filter((e) => ["task_started", "task_settled", "complete"].includes(e.type)),
          ),
        );
        throw error;
      } finally {
        clearTimeout(watchdog);
        await runner.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
