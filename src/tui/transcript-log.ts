/**
 * Tiny in-memory log of user / agent messages used by the `/copy` slash
 * command and the Ctrl+Y keystroke. The TUI's transcript itself is rendered
 * line-by-line into a ScrollBoxRenderable, so there is no straightforward
 * way to retrieve "the last assistant message" as a clean string. This log
 * is the parallel structure that makes copy-out possible.
 *
 * Only logical message bodies belong here — labels (`you:`, `[reasoning]`,
 * `[tool]`, ...) live in the transcript renderer and are stripped before
 * appending so what lands on the clipboard is exactly the text the user
 * (or the agent) wrote.
 */

export type TranscriptEntryKind = "user" | "agent";

export interface TranscriptEntry {
  kind: TranscriptEntryKind;
  /** Final body text. For streamed agent replies, append the resolved text once. */
  text: string;
}

/**
 * Pick the text to copy based on the user's `/copy` argument.
 *
 * - `"last"` (the default): the most recent agent reply. Falls back to the
 *   most recent user message only if no agent reply exists yet — useful when
 *   a user wants to grab their own prompt back before the agent responds.
 * - `"all"`: the entire conversation, in order, formatted with `you:` /
 *   `agent:` labels so the export reads cleanly outside the terminal.
 * - a positive integer N: the last N entries (any kind), formatted the same
 *   way as `"all"`.
 *
 * Returns `undefined` when the requested slice is empty so the caller can
 * surface "nothing to copy yet" instead of writing an empty clipboard.
 */
export function selectCopyText(
  log: readonly TranscriptEntry[],
  argument: "last" | "all" | number,
): string | undefined {
  if (argument === "last") {
    const lastAgent = findLast(log, (entry) => entry.kind === "agent");
    if (lastAgent) return lastAgent.text;
    const lastUser = findLast(log, (entry) => entry.kind === "user");
    return lastUser?.text;
  }

  if (argument === "all") {
    return log.length > 0 ? formatEntries(log) : undefined;
  }

  // Numeric N — clamp to log length and take the tail.
  const n = Math.max(1, Math.floor(argument));
  const slice = log.slice(-n);
  return slice.length > 0 ? formatEntries(slice) : undefined;
}

/**
 * Parse the raw argument portion of a `/copy ...` command. Accepted shapes:
 *
 *   /copy            → "last"
 *   /copy last       → "last"
 *   /copy all        → "all"
 *   /copy 5          → 5
 *
 * Returns `undefined` for malformed input so the caller can show usage help.
 */
export function parseCopyArgument(raw: string): "last" | "all" | number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "last") return "last";
  if (trimmed === "all") return "all";
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 1 && Number.isInteger(n)) return n;
  return undefined;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const candidate = items[i];
    if (candidate !== undefined && predicate(candidate)) return candidate;
  }
  return undefined;
}

function formatEntries(entries: readonly TranscriptEntry[]): string {
  return entries.map((entry) => `${entry.kind === "user" ? "you" : "agent"}: ${entry.text}`).join("\n\n");
}
