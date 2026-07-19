const SYNTHETIC_USER_MESSAGE_OPEN = "<duet-synthetic-user-message>";
const SYNTHETIC_USER_MESSAGE_CLOSE = "</duet-synthetic-user-message>";

/**
 * Mark text injected into a user-role message by the runtime. The marker is
 * intentionally independent of the reminder wording so memory and routing can
 * reject machine plumbing without duplicating prose owned by prompt builders.
 */
export function syntheticUserMessage(text: string): string {
  return `${SYNTHETIC_USER_MESSAGE_OPEN}\n${text.trim()}\n${SYNTHETIC_USER_MESSAGE_CLOSE}`;
}

/** Remove every runtime-owned segment while preserving adjacent real user text. */
export function stripSyntheticUserMessages(text: string): string {
  let stripped = text;
  let start = stripped.indexOf(SYNTHETIC_USER_MESSAGE_OPEN);
  while (start !== -1) {
    const end = stripped.indexOf(SYNTHETIC_USER_MESSAGE_CLOSE, start);
    if (end === -1) break;
    stripped = `${stripped.slice(0, start)}\n${stripped.slice(
      end + SYNTHETIC_USER_MESSAGE_CLOSE.length,
    )}`;
    start = stripped.indexOf(SYNTHETIC_USER_MESSAGE_OPEN);
  }
  return stripped.trim();
}
