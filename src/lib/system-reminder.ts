const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

/**
 * Wrap runtime-injected text in a single `<system-reminder>` block — the one
 * tag for everything the harness says in a user-facing channel. Idempotent:
 * text that already IS one whole reminder block passes through unchanged.
 */
export function systemReminder(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(OPEN) && trimmed.endsWith(CLOSE)) return trimmed;
  return `${OPEN}\n${trimmed}\n${CLOSE}`;
}

/**
 * Remove every `<system-reminder>…</system-reminder>` segment while keeping
 * surrounding text. Memory observation and routing step-triggers project
 * transcripts through this so harness plumbing never becomes a memory or a
 * reroute signal.
 */
export function stripSystemReminders(text: string): string {
  let stripped = text;
  let start = stripped.indexOf(OPEN);
  while (start !== -1) {
    // Depth-aware: injected reminders may nest (a wrapped message that itself
    // contains a reminder block); strip to the MATCHING close, not the first.
    let depth = 0;
    let cursor = start;
    let end = -1;
    while (cursor < stripped.length) {
      const nextOpen = stripped.indexOf(OPEN, cursor + 1);
      const nextClose = stripped.indexOf(CLOSE, cursor + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen;
        continue;
      }
      if (depth === 0) {
        end = nextClose;
        break;
      }
      depth -= 1;
      cursor = nextClose;
    }
    if (end === -1) break;
    stripped = `${stripped.slice(0, start)}\n${stripped.slice(end + CLOSE.length)}`;
    start = stripped.indexOf(OPEN);
  }
  return stripped.trim();
}
