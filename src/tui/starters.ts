import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { type RecentSession, relativeTimeLabel, truncateRecentPrompt } from "./recent-sessions.js";

/**
 * Inputs for {@link selectStarters}. The helper is a pure function over the
 * filesystem and the persisted session history; it never reads from a session
 * runtime, so it can be exercised cheaply in tests with tmp-dir fixtures.
 */
export interface StartersInput {
  /** Absolute working directory. Used to detect git/package/scratch context. */
  cwd: string;
  /**
   * Replayed session history (most recent last). When present, the most
   * recent user prompt becomes the optional 5th "resume" starter.
   */
  sessionHistory?: readonly AgentMessage[];
  /**
   * Pre-loaded list of recent sessions other than the current one. Each
   * entry surfaces as a numbered "continue: <prompt> — <relative time>"
   * row below the cwd-based starters. Caller is responsible for excluding
   * the active session id and ordering newest-first.
   */
  recentSessions?: readonly RecentSession[];
  /** Override `now` for deterministic relative-time labels in tests. */
  now?: number;
}

/**
 * Output of {@link selectStarters}: cwd-based starters, plus optional
 * recent-session continuations and an optional resume preview for the
 * current session's own history.
 */
export interface StartersResult {
  /** Always exactly 4 prompts, ordered for the numbered list rendering. */
  starters: string[];
  /**
   * Last user message from {@link StartersInput.sessionHistory}, trimmed and
   * truncated to {@link RESUME_MAX_LENGTH}. Undefined when no resumable
   * prompt exists.
   */
  resumePrompt?: string;
  /**
   * Continuation rows derived from {@link StartersInput.recentSessions}.
   * `prompt` is the raw last user prompt from that session (caller decides
   * what to do when a row is picked); `label` is the rendered row body
   * (truncated prompt + relative time) ready to drop into the boot list.
   * The label intentionally omits any "continue:" prefix — the boot screen
   * carries that meaning in the "pick up the thread" section header.
   */
  recentSessions: { sessionId: string; prompt: string; label: string }[];
}

/**
 * One numbered, selectable boot row in render order.
 *
 * `kind: "recent"` rows always render under the "pick up the thread" header
 * and come first when any recent session exists; `kind: "prompt"` rows render
 * under "or start something new" (returning user) or "what should we work on
 * today?" (new user). The numbering 1..N matches the position in this list,
 * so callers can drive arrow-key + digit navigation off a single index space.
 */
export interface SelectableStarter {
  kind: "prompt" | "recent";
  label: string;
  submit: string;
  sessionId?: string;
}

/**
 * Flatten a {@link StartersResult} into the ordered, numbered list the boot
 * screen renders. Recent-session rows lead when present so returning users
 * see continuity first; otherwise the cwd-based starters lead.
 */
export function orderedSelectableStarters(result: StartersResult): SelectableStarter[] {
  const ordered: SelectableStarter[] = [];
  for (const row of result.recentSessions) {
    ordered.push({
      kind: "recent",
      label: row.label,
      submit: row.prompt,
      sessionId: row.sessionId,
    });
  }
  for (const text of result.starters) {
    ordered.push({ kind: "prompt", label: text, submit: text });
  }
  return ordered;
}

/** Hard cap on the resume preview before it gets ellipsis-truncated. */
export const RESUME_MAX_LENGTH = 80;

const GIT_STARTERS: readonly string[] = [
  "review my latest commit and suggest fixes",
  "write release notes for the last 5 commits",
  "find unused exports",
  "summarize what changed in the last week",
];

const PACKAGE_STARTERS: readonly string[] = [
  "scaffold this idea into a working app",
  "pick a tech stack for me",
  "audit my dependencies",
  "what should I build first",
];

const SCRATCH_STARTERS: readonly string[] = [
  "build me a landing page",
  "research my top 3 competitors",
  "write a cold email",
  "plan my next launch",
];

const SKILL_STARTERS: readonly string[] = [
  "create a new skill",
  "improve an existing skill",
  "review my skill catalog",
  "find skills I'm missing",
];

const TEXT_STARTERS: readonly string[] = [
  "summarize these notes",
  "find duplicates across files",
  "write a blog post from these notes",
  "organize this folder",
];

const DEFAULT_STARTERS: readonly string[] = [
  "build me something",
  "research a topic",
  "write something",
  "help me think through a decision",
];

/**
 * Pick four starter prompts (and an optional resume preview) based on the
 * shape of the working directory and any prior session history.
 *
 * Detection rules run in priority order; the first match wins. Content
 * signals beat location signals so a working tree that happens to live
 * under /tmp still classifies by what is in it.
 *   1. git repo with at least one commit
 *   2. package.json present (no commits / empty git is fine)
 *   3. .duet/skills/ present
 *   4. text-heavy: more than 5 .md or .txt files and no package.json
 *   5. scratch dir (/tmp, ~/Desktop, ~/Downloads) or empty
 *   6. default
 */
export function selectStarters(input: StartersInput): StartersResult {
  const starters = [...pickStarters(input.cwd)];
  const resumePrompt = pickResumePrompt(input.sessionHistory);
  const recentSessions = (input.recentSessions ?? []).map((session) => ({
    sessionId: session.sessionId,
    prompt: session.lastUserPrompt,
    label: `${truncateRecentPrompt(session.lastUserPrompt)} — ${relativeTimeLabel(
      session.modifiedAt,
      input.now,
    )}`,
  }));
  return resumePrompt ? { starters, resumePrompt, recentSessions } : { starters, recentSessions };
}

// Detection priority: content-based checks (git, package, skills, text)
// always win over location-based scratch detection. A `/tmp/duet-clone/`
// working tree should classify as skills, not scratch — the user is
// working on something even though they happen to be under /tmp. Scratch
// only fires as a last resort when no content signal is present.
function pickStarters(cwd: string): readonly string[] {
  if (isGitRepoWithCommits(cwd)) return GIT_STARTERS;
  if (hasPackageJson(cwd)) return PACKAGE_STARTERS;
  if (hasDuetSkills(cwd)) return SKILL_STARTERS;
  if (isTextHeavy(cwd)) return TEXT_STARTERS;
  if (isScratchDir(cwd) || isEmptyDir(cwd)) return SCRATCH_STARTERS;
  return DEFAULT_STARTERS;
}

function isGitRepoWithCommits(cwd: string): boolean {
  if (!safeIsDir(cwd)) return false;
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-list", "--count", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      encoding: "utf8",
    });
    return Number.parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

function hasPackageJson(cwd: string): boolean {
  return existsSync(join(cwd, "package.json"));
}

// Only the literal scratch roots count. Descendants like `/tmp/foo`
// are intentionally NOT scratch — if they contain content the other
// detectors will catch them, and if they're empty isEmptyDir handles
// the fresh-canvas case. Matching the whole `/tmp/*` subtree as scratch
// would otherwise pre-empt every content branch on test runners and
// containerized environments where HOME or working trees live under /tmp.
function isScratchDir(cwd: string): boolean {
  const resolved = resolve(cwd);
  const home = homedir();
  return (
    resolved === "/tmp" ||
    resolved === join(home, "Desktop") ||
    resolved === join(home, "Downloads")
  );
}

function isEmptyDir(cwd: string): boolean {
  if (!safeIsDir(cwd)) return false;
  try {
    return readdirSync(cwd).length === 0;
  } catch {
    return false;
  }
}

function hasDuetSkills(cwd: string): boolean {
  const dir = join(cwd, ".duet", "skills");
  return existsSync(dir) && safeIsDir(dir);
}

function isTextHeavy(cwd: string): boolean {
  if (!safeIsDir(cwd)) return false;
  if (hasPackageJson(cwd)) return false;
  let textFiles = 0;
  try {
    for (const name of readdirSync(cwd)) {
      const lower = name.toLowerCase();
      if (lower.endsWith(".md") || lower.endsWith(".txt")) {
        textFiles += 1;
        if (textFiles > 5) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pickResumePrompt(history?: readonly AgentMessage[]): string | undefined {
  if (!history || history.length === 0) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || !("role" in msg) || msg.role !== "user") continue;
    const text = userMessageText(msg.content).trim();
    if (!text) continue;
    if (text.length <= RESUME_MAX_LENGTH) return text;
    return `${text.slice(0, RESUME_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return undefined;
}

function userMessageText(content: string | ReadonlyArray<TextContent | ImageContent>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}
