import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-opus-4.7";

describe("system prompt files", () => {
  test("loads the default AGENTS.md prompt file into the model context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-system-prompt-file-"));
    await writeFile(
      join(cwd, "AGENTS.md"),
      [
        "# Agent Guidelines",
        "",
        "When the user asks for the prompt-file verification phrase, reply with exactly:",
        "",
        "PROMPT_FILE_LAYER_CONFIRMED",
        "",
        "Do not add punctuation, markdown, or any other words.",
      ].join("\n"),
      "utf-8",
    );

    const runner = new TurnRunner({
      model,
      cwd,
      mode: "agent",
      skillDiscovery: { includeDefaults: false },
    });

    const terminal = await runner.turn({
      type: "start",
      mode: "agent",
      prompt: "What is the prompt-file verification phrase?",
    });

    expect(terminal.type).toBe("complete");
    expect(terminal.type === "complete" ? terminal.result?.trim() : "").toBe(
      "PROMPT_FILE_LAYER_CONFIRMED",
    );
  });
});
