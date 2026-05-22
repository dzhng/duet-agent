import { describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const baselineModel = process.env.EVAL_BASELINE_MODEL ?? "opus-4.7";
const overrideModel = process.env.EVAL_OVERRIDE_MODEL ?? "sonnet-4.6";

/**
 * Live CLI eval covering the "hey can you review this /model X" use case:
 * an inline `/model` reference embedded anywhere inside the one-shot
 * prompt must swap the model that the very next (and only) turn runs
 * on, and the slash form must be stripped from the prompt the agent
 * sees (so the agent does not have to re-parse local UI commands as
 * user content).
 *
 * The eval spawns the real `src/cli.ts` binary in JSONL mode so the
 * assertion observes the same `turn_started` payload a production
 * subscriber would, then inspects `state.options.model` to confirm the
 * runner picked up the override.
 */
describe("inline slash commands (live CLI)", () => {
  testIfDocker(
    "inline /model swaps the model used by the very prompt that contains it",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-inline-model-"));
      try {
        const prompt = dedent`
          hey can you review this and reply in one short sentence.
          /model ${overrideModel}
        `;
        const result = await runCliEvents(["--workdir", workDir, "--model", baselineModel, prompt]);

        expect(result.exitCode).toBe(0);

        const turnStarted = result.events.find((event) => event.type === "turn_started");
        expect(turnStarted).toBeDefined();
        // The turn that delivers the prompt must already be running on the
        // inline-selected model. If the override only landed on a later
        // turn, the contract would be broken for the one-shot case.
        expect(turnStarted?.state.options?.model).toBe(overrideModel);

        // Stderr must surface the [model] confirmation block emitted by
        // the inline handler so non-TUI users see the swap took effect.
        expect(result.stderr).toMatch(/\[model\][^\n]*next turn will use/);
        expect(result.stderr).toContain(overrideModel);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "inline /thinking swaps the thinking level for the same turn",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-inline-thinking-"));
      try {
        const prompt = dedent`
          please think carefully and reply in one short sentence.
          /thinking high
        `;
        const result = await runCliEvents(["--workdir", workDir, "--model", baselineModel, prompt]);

        expect(result.exitCode).toBe(0);

        const turnStarted = result.events.find((event) => event.type === "turn_started");
        expect(turnStarted).toBeDefined();
        expect(turnStarted?.state.options?.thinkingLevel).toBe("high");

        expect(result.stderr).toMatch(/\[thinking\][^\n]*next turn will think at high/);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

async function runCliEvents(args: string[]): Promise<{
  exitCode: number;
  stderr: string;
  events: TurnEvent[];
}> {
  // --no-skill-sync skips the duet.so default-skill fetch the CLI normally
  // runs at startup when DUET_API_KEY is set. The eval asserts CLI behavior,
  // not that side effect; disabling it keeps gateway auth intact.
  const proc = Bun.spawn(["bun", "src/cli.ts", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, events: parseJsonEvents(stdout) };
}

function parseJsonEvents(stdout: string): TurnEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}
