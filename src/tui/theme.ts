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
// it is a no-op (it only closes open pickers, which is self-evident).
// The label is "exit" not "quit" because Ctrl+C on an empty idle composer
// asks for confirmation first (see HINT_EXIT_CONFIRM) rather than quitting
// on the first press.
export const HINT_IDLE = "Enter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+C: exit";

// Persistent prompt shown in the status line after a bare Ctrl+C on an
// empty, idle composer. It does not auto-dismiss: the user either confirms
// (Ctrl+C again or Enter) or cancels by pressing any other key.
export const HINT_EXIT_CONFIRM = "Press Ctrl+C again or Enter to exit";
// Ctrl+Enter surfaces in the running hint only; advertising it on the
// idle hint would be noise (idle has nothing to steer against). The
// keystroke is a no-op when the composer is empty, so a single line
// covers both running cases without flicker.
export const HINT_RUNNING =
  "Enter: queue follow-up · Ctrl+Enter: steer · PgUp/PgDn: scroll · Esc: interrupt";

/**
 * Terminal-aware copy keystroke shown in the hint only while a non-empty
 * drag selection exists. The keystroke handler accepts Cmd+C, Cmd+Shift+C,
 * and Ctrl+Shift+C on every platform; the label here picks whichever one
 * actually reaches the TUI on the current terminal so users do not chase
 * a keystroke their terminal silently swallows.
 *
 * Warp on macOS reserves both Cmd+C (block-copy) and Cmd+Shift+C
 * (command-palette search) for its own UI and never forwards either to
 * TUI applications, so on Warp we surface Ctrl+Shift+C — the only combo
 * Warp passes through. Other macOS terminals (Ghostty, kitty, recent
 * iTerm2 with the right keybindings) forward Cmd+C, which matches Mac
 * muscle memory. Linux and Windows terminals universally use
 * Ctrl+Shift+C so bare Ctrl+C can stay reserved for "exit."
 */
export const COPY_KEYSTROKE_LABEL = chooseCopyKeystrokeLabel();
export const HINT_SELECTION_COPY = `${COPY_KEYSTROKE_LABEL}: copy`;

function chooseCopyKeystrokeLabel(): string {
  if (process.platform !== "darwin") return "Ctrl+Shift+C";
  // TERM_PROGRAM=WarpTerminal is set by Warp itself; it is the most
  // reliable signal we have without a runtime keypress probe.
  if (process.env.TERM_PROGRAM === "WarpTerminal") return "Ctrl+Shift+C";
  return "Cmd+C";
}
