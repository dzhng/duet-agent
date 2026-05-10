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

export const HINT_IDLE =
  "Enter: send · Shift+Enter: newline · drag-select + Cmd+C to copy · Esc: quit";
export const HINT_RUNNING = "Enter: queue follow-up · drag-select + Cmd+C to copy · Esc: interrupt";
