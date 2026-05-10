import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Filesystem layout the helper expects:
 *   <root>/<session-dir>/state.json
 *
 * `state.json` is the same file the runtime writes via Session persistence;
 * we only read the fields needed for the boot list (id, updatedAt, the most
 * recent user prompt). Sessions with no user messages or unparseable JSON
 * are silently skipped so a single bad file never breaks the boot screen.
 */

/** Default path mirrors {@link DEFAULT_SESSION_STORAGE_DIR} from session-manager. */
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".duet", "sessions");

export interface RecentSessionsInput {
  /**
   * Active session id to skip. The boot screen renders inside an already-open
   * session and we don't want to surface a "continue" line for the session
   * the user is literally already in.
   */
  excludeId?: string;
  /** Maximum recent sessions to return. Default 3. */
  limit?: number;
  /**
   * Override the sessions directory. Tests pass a tmp dir; production uses
   * the default (~/.duet/sessions).
   */
  sessionsRoot?: string;
}

export interface RecentSession {
  /** Stable session id, matches the directory name on disk. */
  sessionId: string;
  /** Most recent user-authored prompt, trimmed but not truncated. */
  lastUserPrompt: string;
  /** Epoch ms last-modified, used for ordering. */
  modifiedAt: number;
}

/** Hard cap on the displayed prompt before ellipsis truncation. */
export const RECENT_PROMPT_MAX_LENGTH = 60;

/**
 * Scan the on-disk sessions directory and return up to `limit` sessions
 * sorted newest-first. Any session that has no readable last user prompt
 * (empty messages, malformed JSON, missing state.json) is skipped so the
 * caller can decide rendering on a clean list.
 */
export function listRecentSessions(input: RecentSessionsInput = {}): RecentSession[] {
  const root = input.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  const limit = input.limit ?? 3;
  const excludeId = input.excludeId;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const candidates: RecentSession[] = [];
  for (const name of entries) {
    if (excludeId && name === excludeId) continue;
    const statePath = join(root, name, "state.json");
    let raw: string;
    let modifiedAt: number;
    try {
      const stats = statSync(statePath);
      if (!stats.isFile()) continue;
      modifiedAt = stats.mtimeMs;
      raw = readFileSync(statePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const prompt = extractLastUserPrompt(parsed);
    if (!prompt) continue;
    candidates.push({ sessionId: name, lastUserPrompt: prompt, modifiedAt });
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return candidates.slice(0, limit);
}

/** Truncate a prompt for boot-row display; appends `…` when over the cap. */
export function truncateRecentPrompt(prompt: string, max = RECENT_PROMPT_MAX_LENGTH): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render a relative-time label suitable for a single boot row.
 * `now` is injectable for tests; production passes `Date.now()`.
 */
export function relativeTimeLabel(modifiedAt: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - modifiedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/**
 * Reach into a parsed state.json and return the last user-authored prompt.
 * The runtime persists messages under `state.agent.messages`; each message
 * has either a string `content` or a list of content blocks where text
 * blocks expose `{ type: "text", text }`.
 */
function extractLastUserPrompt(parsed: unknown): string | undefined {
  const messages = pickMessages(parsed);
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: unknown }).role;
    if (role !== "user") continue;
    const text = userMessageText((msg as { content?: unknown }).content);
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function pickMessages(parsed: unknown): unknown[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const state = (parsed as { state?: unknown }).state;
  if (!state || typeof state !== "object") return undefined;
  const agent = (state as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object") return undefined;
  const messages = (agent as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}
