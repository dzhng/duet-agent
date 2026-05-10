import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { listRecentSessions, relativeTimeLabel } from "../src/tui/recent-sessions.js";
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
    const history = [userMessage("first"), assistantMessage("ack"), userMessage("draft a tweet")];
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

  it("surfaces recent-session continuations with truncation and relative time", () => {
    const dir = fixtureDir("recent");
    const now = 1_000_000_000_000;
    const longPrompt = "plan the launch step by step ".repeat(10).trim();
    const result = selectStarters({
      cwd: dir,
      now,
      recentSessions: [
        {
          sessionId: "session_aaa",
          lastUserPrompt: "draft a tweet thread",
          modifiedAt: now - 5 * 60_000,
        },
        {
          sessionId: "session_bbb",
          lastUserPrompt: longPrompt,
          modifiedAt: now - 3 * 60 * 60_000,
        },
      ],
    });
    expect(result.recentSessions).toHaveLength(2);
    expect(result.recentSessions[0]).toMatchObject({
      sessionId: "session_aaa",
      prompt: "draft a tweet thread",
    });
    expect(result.recentSessions[0]!.label).toBe("continue: draft a tweet thread \u2014 5m ago");
    expect(result.recentSessions[1]!.label.endsWith("\u2014 3h ago")).toBe(true);
    expect(result.recentSessions[1]!.label).toContain("\u2026");
  });

  it("omits recent sessions when none provided", () => {
    const dir = fixtureDir("recent-empty");
    const result = selectStarters({ cwd: dir });
    expect(result.recentSessions).toEqual([]);
  });
});

describe("listRecentSessions", () => {
  function writeSession(
    root: string,
    id: string,
    messages: Array<{ role: string; content: unknown }>,
    mtimeMs?: number,
  ): void {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        sessionId: id,
        updatedAt: mtimeMs ?? Date.now(),
        state: { agent: { messages } },
      }),
    );
    if (mtimeMs !== undefined) {
      const seconds = mtimeMs / 1000;
      utimesSync(path, seconds, seconds);
    }
  }

  it("returns sessions sorted newest-first and excludes the active id", () => {
    const root = fixtureDir("recent-sessions");
    writeSession(
      root,
      "session_old",
      [{ role: "user", content: "old prompt" }],
      Date.now() - 60 * 60_000,
    );
    writeSession(
      root,
      "session_mid",
      [{ role: "user", content: [{ type: "text", text: "mid prompt" }] }],
      Date.now() - 30 * 60_000,
    );
    writeSession(
      root,
      "session_new",
      [{ role: "user", content: "new prompt" }],
      Date.now() - 5 * 60_000,
    );
    writeSession(root, "session_active", [{ role: "user", content: "current" }], Date.now());

    const result = listRecentSessions({
      sessionsRoot: root,
      excludeId: "session_active",
    });
    expect(result.map((entry) => entry.sessionId)).toEqual([
      "session_new",
      "session_mid",
      "session_old",
    ]);
    expect(result[0]!.lastUserPrompt).toBe("new prompt");
    expect(result[1]!.lastUserPrompt).toBe("mid prompt");
  });

  it("skips sessions with no user messages or unparseable state", () => {
    const root = fixtureDir("recent-skip");
    writeSession(root, "session_empty", []);
    writeSession(root, "session_assistant_only", [
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    mkdirSync(join(root, "session_garbage"));
    writeFileSync(join(root, "session_garbage", "state.json"), "{not json");
    writeSession(root, "session_good", [{ role: "user", content: "keep me" }]);

    const result = listRecentSessions({ sessionsRoot: root });
    expect(result.map((entry) => entry.sessionId)).toEqual(["session_good"]);
  });

  it("returns an empty list when the sessions directory is missing", () => {
    const result = listRecentSessions({
      sessionsRoot: join(tmpdir(), "definitely-not-a-real-path-" + Date.now()),
    });
    expect(result).toEqual([]);
  });

  it("respects the limit", () => {
    const root = fixtureDir("recent-limit");
    for (let i = 0; i < 5; i += 1) {
      writeSession(
        root,
        `session_${i}`,
        [{ role: "user", content: `prompt ${i}` }],
        Date.now() - i * 60_000,
      );
    }
    const result = listRecentSessions({ sessionsRoot: root, limit: 2 });
    expect(result).toHaveLength(2);
  });
});

describe("relativeTimeLabel", () => {
  const base = 1_700_000_000_000;
  it("renders 'just now' for sub-minute deltas", () => {
    expect(relativeTimeLabel(base - 30_000, base)).toBe("just now");
  });
  it("renders minutes / hours / yesterday", () => {
    expect(relativeTimeLabel(base - 5 * 60_000, base)).toBe("5m ago");
    expect(relativeTimeLabel(base - 3 * 60 * 60_000, base)).toBe("3h ago");
    expect(relativeTimeLabel(base - 24 * 60 * 60_000, base)).toBe("yesterday");
    expect(relativeTimeLabel(base - 5 * 24 * 60 * 60_000, base)).toBe("5d ago");
  });
});
