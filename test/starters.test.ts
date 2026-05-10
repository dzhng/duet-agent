import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { RESUME_MAX_LENGTH, selectStarters } from "../src/tui/starters.js";

function userMessage(text: string | { type: "text"; text: string }[]): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function fixtureDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `starters-${label}-`));
}

describe("selectStarters", () => {
  it("picks git starters when cwd is a git repo with commits", () => {
    const dir = fixtureDir("git");
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, "README.md"), "hi");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    const result = selectStarters({ cwd: dir });
    expect(result.starters).toEqual([
      "review my latest commit and suggest fixes",
      "write release notes for the last 5 commits",
      "find unused exports",
      "summarize what changed in the last week",
    ]);
  });

  it("picks package starters when package.json exists without git commits", () => {
    const dir = fixtureDir("pkg");
    writeFileSync(join(dir, "package.json"), "{}");

    const result = selectStarters({ cwd: dir });
    expect(result.starters[0]).toBe("scaffold this idea into a working app");
    expect(result.starters).toHaveLength(4);
  });

  it("picks scratch starters for /tmp-style and empty dirs", () => {
    const dir = fixtureDir("scratch");
    const result = selectStarters({ cwd: dir });
    expect(result.starters[0]).toBe("build me a landing page");
  });

  it("picks skill starters when .duet/skills/ is present and no package/git", () => {
    // A non-scratch parent so the SCRATCH branch does not pre-empt skills.
    const home = fixtureDir("skill-home");
    const dir = join(home, "project");
    mkdirSync(join(dir, ".duet", "skills"), { recursive: true });
    writeFileSync(join(dir, "notes.md"), "hi");

    const result = selectStarters({ cwd: dir });
    expect(result.starters[0]).toBe("create a new skill");
  });

  it("picks text-heavy starters when many markdown files and no package.json", () => {
    const home = fixtureDir("text-home");
    const dir = join(home, "notes");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(join(dir, `note-${i}.md`), "hi");
    }

    const result = selectStarters({ cwd: dir });
    expect(result.starters[0]).toBe("summarize these notes");
  });

  it("falls back to default starters when nothing matches", () => {
    const home = fixtureDir("default-home");
    const dir = join(home, "child");
    mkdirSync(dir, { recursive: true });
    // One non-text file, no package.json, no git, no skills, not empty.
    writeFileSync(join(dir, "image.png"), "x");

    const result = selectStarters({ cwd: dir });
    expect(result.starters[0]).toBe("build me something");
  });

  it("surfaces the most recent short user prompt as resumePrompt", () => {
    const dir = fixtureDir("resume");
    const history = [
      userMessage("first"),
      assistantMessage("ack"),
      userMessage("draft a tweet"),
    ];
    const result = selectStarters({ cwd: dir, sessionHistory: history });
    expect(result.resumePrompt).toBe("draft a tweet");
  });

  it("truncates long resume prompts with an ellipsis", () => {
    const dir = fixtureDir("resume-long");
    const long = "a".repeat(RESUME_MAX_LENGTH + 50);
    const history = [userMessage(long)];
    const result = selectStarters({ cwd: dir, sessionHistory: history });
    expect(result.resumePrompt).toBeDefined();
    expect(result.resumePrompt!.endsWith("…")).toBe(true);
    expect(result.resumePrompt!.length).toBe(RESUME_MAX_LENGTH);
  });

  it("omits resumePrompt when no user message exists", () => {
    const dir = fixtureDir("resume-empty");
    const result = selectStarters({ cwd: dir, sessionHistory: [] });
    expect(result.resumePrompt).toBeUndefined();
  });

  it("supports user messages with content blocks", () => {
    const dir = fixtureDir("resume-blocks");
    const history = [userMessage([{ type: "text", text: "hello world" }])];
    const result = selectStarters({ cwd: dir, sessionHistory: history });
    expect(result.resumePrompt).toBe("hello world");
  });
});
