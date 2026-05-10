// Shared TUI palette and footer hints. Kept in one place so individual
// renderers stay focused on layout and the color story stays consistent
// across the transcript, sidebar, and autocomplete panels.
export const COLORS = {
  user: "#7DD3FC",
  agent: "#FFFFFF",
  reasoning: "#9CA3AF",
  tool: "#A78BFA",
  system: "#FBBF24",
  error: "#F87171",
  hint: "#6B7280",
  memory: "#6B7280",
  status: "#34D399",
  border: "#374151",
} as const;

// Esc is intentionally absent from the idle hint: when no turn is running
// it is a no-op (it only closes open pickers, which is self-evident). Use
// Ctrl+C to quit the TUI — the universal terminal convention.
export const HINT_IDLE = "Enter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+C: quit";
export const HINT_RUNNING = "Enter: queue follow-up · PgUp/PgDn: scroll · Esc: interrupt";

/**
 * Platform-aware copy keystroke shown in the hint only while a non-empty
 * drag selection exists. macOS uses Cmd+C because that is the muscle
 * memory every Mac user already has; other platforms use Ctrl+Shift+C so
 * the bare Ctrl+C keystroke can stay reserved for "exit the TUI" — which
 * matches the convention every interactive Linux/Windows terminal app
 * follows. The keystroke and the label come from the same constant so
 * the hint never drifts from the handler that implements it.
 */
export const COPY_KEYSTROKE_LABEL = process.platform === "darwin" ? "Cmd+C" : "Ctrl+Shift+C";
export const HINT_SELECTION_COPY = `${COPY_KEYSTROKE_LABEL}: copy`;
