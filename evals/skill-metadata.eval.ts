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

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("skill metadata + path-based loading", () => {
  testIfDocker(
    "system prompt lists skill metadata with path and the model reads the SKILL.md from disk",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-skill-path-eval-"));
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

      // The model should `read` (or `bash cat`) the SKILL.md from the path
      // surfaced in the system prompt's skill metadata. Either way produces a
      // tool call whose input mentions the absolute skill path.
      const skillReads: Array<{ tool: string; input: unknown }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.status !== "running") return;
        const serialized = JSON.stringify(step.input ?? {});
        if (serialized.includes(skillPath)) {
          skillReads.push({ tool: step.toolName, input: step.input });
        }
      });

      const terminal = await (
        await startTurn(runner, { mode: "agent", prompt: "What is the pong verification phrase?" })
      ).turn;

      expect(terminal.type).toBe("complete");
      // The model must have loaded the SKILL.md at the path surfaced in
      // its metadata. We accept any tool whose input references the
      // absolute path (read, bash cat, etc.) so the assertion stays
      // behavioral and is not coupled to a specific tool implementation.
      expect(skillReads.length).toBeGreaterThanOrEqual(1);
      expect(terminal.type === "complete" ? terminal.result?.trim() : "").toBe(
        "PONG_SKILL_LAZY_LOADED",
      );
    },
    60_000,
  );
});
