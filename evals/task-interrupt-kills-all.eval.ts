import { describe, expect } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { delay } from "../test/helpers/async.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("task interrupt", () => {
  testIfDocker(
    "kills every background process before interrupted terminal",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "duet-task-interrupt-"));
      const started = join(dir, "started");
      const pid = join(dir, "pid");
      const stopped = join(dir, "stopped");
      const command = `bun evals/fixtures/task-work.ts --started-file ${started} --pid-file ${pid} --release-file ${join(dir, "release")} --stopped-file ${stopped} --stdout RUNNING --stderr none`;
      const runner = new TurnRunner({
        model,
        mode: "agent",
        cwd: process.cwd(),
        skillDiscovery: { includeDefaults: false },
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));
      const active = (
        await startTurn(runner, {
          mode: "agent",
          prompt: `Run \`${command}\` with run_in_background=true, then wait.`,
        })
      ).turn;
      for (let attempt = 0; attempt < 3_000; attempt += 1) {
        if (
          await access(started).then(
            () => true,
            () => false,
          )
        )
          break;
        await delay(10);
      }
      await access(started);
      // Falsification target (Docker run pending): remove taskManager.interruptAll; the marker
      // and interrupted-terminal checks must turn red.
      runner.interrupt({ type: "interrupt" });
      expect((await active).type).toBe("interrupted");
      expect(await readFile(stopped, "utf8")).toContain("SIGTERM");
      expect(events.filter((event) => event.type === "interrupted")).toHaveLength(1);
      await runner.dispose();
    },
    120_000,
  );
});
