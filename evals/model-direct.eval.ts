import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";

// `duet model` passes -m straight to the gateway, so evals use full gateway
// slugs, not pi shorthands. Defaults are the cheapest verified model per type.
const textModel = process.env.EVAL_MODEL ?? "anthropic/claude-haiku-4.5";
const imageModel = process.env.EVAL_IMAGE_MODEL ?? "openai/gpt-image-1-mini";
const videoModel = process.env.EVAL_VIDEO_MODEL ?? "bytedance/seedance-2.0-fast";

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
        ["bun", "src/cli.ts", "model", "-m", textModel, "Reply with the single word: pong"],
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

  testIfDocker(
    "generates an image file from a dedicated image model",
    async () => {
      const out = join(mkdtempSync(join(tmpdir(), "duet-model-")), "art.png");
      const proc = Bun.spawn(
        ["bun", "src/cli.ts", "model", "-m", imageModel, "--type", "image", "-o", out, "a red fox"],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, stderr).toBe(0);
      expect((await stat(out)).size).toBeGreaterThan(1000);
    },
    180_000,
  );

  testIfDocker(
    "generates a video file from a video model",
    async () => {
      const out = join(mkdtempSync(join(tmpdir(), "duet-model-")), "clip.mp4");
      const proc = Bun.spawn(
        [
          "bun",
          "src/cli.ts",
          "model",
          "-m",
          videoModel,
          "--type",
          "video",
          "-o",
          out,
          "slow pan over dunes",
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, stderr).toBe(0);
      expect((await stat(out)).size).toBeGreaterThan(10000);
    },
    600_000,
  );
});
