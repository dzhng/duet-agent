import { describe, expect, test } from "bun:test";

import { HINT_IDLE, HINT_RUNNING } from "../src/tui/theme.js";

// The Enter and Esc key contracts are documented to users solely through
// these footer hints, so lock the wording. Idle: Shift+Enter inserts a
// newline; Esc is intentionally absent because it is a no-op when no turn
// is running, and Ctrl+C is the way out. Running: Enter queues a
// follow-up (single gesture, single mental model) and Esc interrupts the
// in-flight turn.
describe("TUI hint strings", () => {
  test("idle hint advertises Enter to send, Shift+Enter for newline, and Ctrl+C to quit", () => {
    expect(HINT_IDLE).toContain("Enter: send");
    expect(HINT_IDLE).toContain("Shift+Enter: newline");
    expect(HINT_IDLE).toContain("Ctrl+C: quit");
    // Idle Esc is a no-op (only closes open pickers); do not advertise it
    // as a quit affordance.
    expect(HINT_IDLE).not.toContain("Esc");
  });

  test("running hint advertises queue, Esc-to-interrupt, and no Shift+Enter branch", () => {
    expect(HINT_RUNNING).toContain("Enter: queue follow-up");
    expect(HINT_RUNNING).not.toContain("Shift+Enter");
    expect(HINT_RUNNING).not.toContain("steer");
    expect(HINT_RUNNING).toContain("Esc: interrupt");
  });
});
