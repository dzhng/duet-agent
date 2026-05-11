import { describe, expect, test } from "bun:test";

import { HINT_IDLE, HINT_RUNNING } from "../src/tui/theme.js";

// The Enter, Ctrl+Enter, and Esc key contracts are documented to users
// solely through these footer hints, so lock the wording. Idle:
// Shift+Enter inserts a newline; Esc is intentionally absent because it
// is a no-op when no turn is running, and Ctrl+C is the way out.
// Running: Enter queues a soft follow-up, Ctrl+Enter steers (pickup at
// next agent boundary), Esc interrupts the in-flight turn. Three
// gestures, three semantics, each tagged with the verb that matches
// what it does.
describe("TUI hint strings", () => {
  test("idle hint advertises Enter to send, Shift+Enter for newline, and Ctrl+C to quit", () => {
    expect(HINT_IDLE).toContain("Enter: send");
    expect(HINT_IDLE).toContain("Shift+Enter: newline");
    expect(HINT_IDLE).toContain("Ctrl+C: quit");
    // Idle Esc is a no-op (only closes open pickers); do not advertise it
    // as a quit affordance.
    expect(HINT_IDLE).not.toContain("Esc");
    // Ctrl+Enter is a no-op while idle (plain Enter already submits), so
    // leave it off the idle hint to avoid noise.
    expect(HINT_IDLE).not.toContain("Ctrl+Enter");
  });

  test("running hint advertises queue, Ctrl+Enter steer, Esc-to-interrupt, and no Shift+Enter branch", () => {
    expect(HINT_RUNNING).toContain("Enter: queue follow-up");
    expect(HINT_RUNNING).toContain("Ctrl+Enter: steer");
    expect(HINT_RUNNING).toContain("Esc: interrupt");
    expect(HINT_RUNNING).not.toContain("Shift+Enter");
  });
});
