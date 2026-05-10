import { describe, expect, test } from "bun:test";

import { HINT_IDLE, HINT_RUNNING } from "../src/tui/theme.js";

// The Enter key contract is documented to users solely through these footer
// hints. Lock the wording so the "Shift+Enter inserts a newline" behaviour
// keeps a visible affordance in the idle state, and so the running state
// does not advertise the removed steer/queue split.
describe("TUI hint strings", () => {
  test("idle hint advertises Enter to send and Shift+Enter for a newline", () => {
    expect(HINT_IDLE).toContain("Enter: send");
    expect(HINT_IDLE).toContain("Shift+Enter: newline");
    expect(HINT_IDLE).toContain("Esc");
  });

  test("running hint advertises a single queue gesture and no Shift+Enter branch", () => {
    expect(HINT_RUNNING).toContain("Enter: queue follow-up");
    expect(HINT_RUNNING).not.toContain("Shift+Enter");
    expect(HINT_RUNNING).not.toContain("steer");
    expect(HINT_RUNNING).toContain("Esc");
  });
});
