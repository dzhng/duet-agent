import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("spawn task parallelism", () => {
  testIfDocker(
    "starts two children before either settles and keeps their event origins distinct",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-spawn-parallel-"));
      const fixture = (name: string) => {
        const started = join(dir, `${name}.started`);
        const pid = join(dir, `${name}.pid`);
        const release = join(dir, `${name}.release`);
        const stopped = join(dir, `${name}.stopped`);
        return {
          started,
          release,
          command: `bun evals/fixtures/task-work.ts --started-file ${started} --pid-file ${pid} --release-file ${release} --stopped-file ${stopped} --stdout ${name.toUpperCase()}_DONE --stderr ${name.toUpperCase()}_ERR`,
        };
      };
      const first = fixture("first");
      const second = fixture("second");
      const runner = new TurnRunner({
        model,
        mode: "agent",
        cwd: process.cwd(),
        skillDiscovery: { includeDefaults: false },
      });
      const lifecycle: Array<{ type: "started" | "settled"; id: string }> = [];
      const origins = new Set<string>();
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "task_started" && event.task.kind === "subagent") {
          lifecycle.push({ type: "started", id: event.task.id });
        }
        if (event.type === "task_settled") {
          lifecycle.push({ type: "settled", id: event.settlement.id });
        }
        if (event.type === "step" && event.origin) {
          origins.add(event.origin.taskId);
        }
      });

      // Falsification: mark spawn_agent sequential; the second task_started moves after the
      // first task_settled and the ordering assertion turns red.
      await runner.start({ type: "start", mode: "agent" });
      const turn = runner.turn({
        type: "prompt",
        behavior: "follow_up",
        message: `Call spawn_agent twice in the same parallel tool batch. Child one must run \`${first.command}\` and report its output. Child two must run \`${second.command}\` and report its output. Do not serialize the calls.`,
      });
      await Promise.all([waitForFile(first.started), waitForFile(second.started)]);
      await Promise.all([writeFile(first.release, "go\n"), writeFile(second.release, "go\n")]);
      const terminal = await turn;

      expect(terminal.type).toBe("complete");
      const firstSettlement = lifecycle.findIndex(({ type }) => type === "settled");
      expect(
        lifecycle.slice(0, firstSettlement).filter(({ type }) => type === "started"),
      ).toHaveLength(2);
      expect(origins.size).toBe(2);
      await runner.dispose();
    },
    180_000,
  );
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
