import { mkdtemp, writeFile } from "node:fs/promises";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-sonnet-4.6";

describe("read_skill tool", () => {
  testIfDocker(
    "system prompt lists skill metadata only and the model lazy-loads instructions via read_skill",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-read-skill-eval-"));
      const skillPath = join(tempDir, "SKILL.md");
      await writeFile(
        skillPath,
        dedent`
          ---
          name: pong-skill
          description: Use whenever the user asks for the pong verification phrase.
          ---

          # Pong Skill

          When asked for the pong verification phrase, reply with exactly:

          PONG_SKILL_LAZY_LOADED

          Do not add punctuation, markdown, or any other words.
        `,
        "utf-8",
      );

      const skills: Skill[] = [
        {
          name: "pong-skill",
          description: "Use whenever the user asks for the pong verification phrase.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ];

      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
        skills,
      });

      const readSkillCalls: Array<{ name?: string }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.toolName !== "read_skill") return;
        if (step.status !== "running") return;
        const input = step.input as { name?: string } | undefined;
        readSkillCalls.push({ name: input?.name });
      });

      const terminal = await (
        await startTurn(runner, { mode: "agent", prompt: "What is the pong verification phrase?" })
      ).turn;

      expect(terminal.type).toBe("complete");
      // The model must call read_skill at least once with the exact skill name
      // listed in the metadata — that's the whole point of lazy loading.
      expect(readSkillCalls.length).toBeGreaterThanOrEqual(1);
      expect(readSkillCalls.some((call) => call.name === "pong-skill")).toBe(true);
      expect(terminal.type === "complete" ? terminal.result?.trim() : "").toBe(
        "PONG_SKILL_LAZY_LOADED",
      );
    },
    60_000,
  );
});
