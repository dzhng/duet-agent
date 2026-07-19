import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("spawn scope cascade", () => {
  testIfDocker(
    "task_stop on a spawned parent kills its nested fixture process",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-spawn-cascade-"));
      const started = join(dir, "started");
      const pidFile = join(dir, "pid");
      const release = join(dir, "release");
      const stopped = join(dir, "stopped");
      const command = `bun evals/fixtures/task-work.ts --started-file ${started} --pid-file ${pidFile} --release-file ${release} --stopped-file ${stopped} --stdout GRANDCHILD_RUNNING --stderr GRANDCHILD_ERR`;
      const runner = new TurnRunner({
        model,
        mode: "agent",
        cwd: process.cwd(),
        skillDiscovery: { includeDefaults: false },
      });
      const stoppedIds: string[] = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "task_settled" && event.settlement.status === "stopped") {
          stoppedIds.push(event.settlement.id);
        }
      });

      // Falsification: omit closeScope(task:tN) from spawn cleanup; the grandchild PID remains
      // live after task_stop and the process-liveness assertion turns red.
      await (
        await startTurn(runner, {
          mode: "agent",
          prompt: `Call spawn_agent with run_in_background=true. Tell the child: run \`${command}\` with bash in the background, then call task_output on that bash task with wait=60 so your spawn stays alive. After spawn_agent returns, use bash to wait until \`${started}\` exists, then call task_stop on the spawn task id.`,
        })
      ).turn;

      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
      expect(stoppedIds.length).toBeGreaterThanOrEqual(2);
      await runner.dispose();
    },
    180_000,
  );
});
