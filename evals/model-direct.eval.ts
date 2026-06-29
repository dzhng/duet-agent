import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * `duet model` talks to a gateway model directly through the AI SDK, bypassing
 * the agent harness. The text path streams a completion straight to stdout, so a
 * live round-trip is the cleanest proof the gateway provider, auth, and request
 * routing all line up: a real model must produce non-empty output for a trivial
 * prompt. Routes through the duet gateway with DUET_API_KEY, which the docker
 * eval container forwards.
 */
describe("duet model direct CLI", () => {
  testIfDocker(
    "streams a non-empty text completion from the gateway",
    async () => {
      const proc = Bun.spawn(
        ["bun", "src/cli.ts", "model", "-m", model, "Reply with the single word: pong"],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );
});
