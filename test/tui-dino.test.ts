// Pure-core tests for the dino panel's reducer + physics layer. No file
// I/O and no OpenTUI imports, so these run on the host without
// `testIfDocker`. The wiring layer (panel, key handlers, layout) is
// covered by the existing TUI rendering tests once the panel is mounted.

import { describe, expect, test } from "bun:test";
import { actionForKey, applyJump, applyStart } from "../src/tui/dino/input.js";
import { renderCollapsedRow, renderExpanded, EXPANDED_ROWS } from "../src/tui/dino/render.js";
import {
  BASE_SPEED,
  DINO_X,
  GRACE_DISTANCE_CELLS,
  beginCountdown,
  beginGrace,
  freezeRun,
  initialState,
  startRun,
} from "../src/tui/dino/state.js";
import { tick } from "../src/tui/dino/tick.js";

const TICKS_PER_SECOND = 15;
const fixedRandom = () => 0.5;

describe("dino state reducers", () => {
  test("startRun seeds a fresh run from idle", () => {
    const next = startRun(initialState(42));
    expect(next.phase.kind).toBe("running");
    expect(next.highScore).toBe(42);
    expect(next.score).toBe(0);
  });

  test("freezeRun snaps the dino to the ground", () => {
    const running = startRun(initialState(0));
    const airborne = { ...running, dinoY: 2.5, dinoVy: 1.5 };
    const frozen = freezeRun(airborne);
    expect(frozen.phase.kind).toBe("frozen");
    expect(frozen.dinoY).toBe(0);
    expect(frozen.dinoVy).toBe(0);
  });

  test("beginGrace shifts hazards out of the grace window", () => {
    const running = startRun(initialState(0));
    const withClose = {
      ...running,
      obstacles: [
        { x: DINO_X + 3, height: 1 },
        { x: DINO_X + GRACE_DISTANCE_CELLS + 5, height: 1 },
      ],
    };
    const graced = beginGrace(withClose);
    expect(graced.phase.kind).toBe("grace");
    expect(graced.obstacles[0].x).toBeGreaterThan(DINO_X + GRACE_DISTANCE_CELLS);
    // The far obstacle was already outside the grace window and should be
    // untouched.
    expect(graced.obstacles[1].x).toBe(DINO_X + GRACE_DISTANCE_CELLS + 5);
  });
});

describe("dino input router", () => {
  test("space starts a run from idle", () => {
    const idle = initialState(0);
    expect(actionForKey(idle, "space")).toBe("start");
    expect(applyStart(idle).phase.kind).toBe("running");
  });

  test("space jumps while running, but only from the ground", () => {
    const running = startRun(initialState(0));
    expect(actionForKey(running, "space")).toBe("jump");
    const jumped = applyJump(running);
    expect(jumped.dinoVy).toBeGreaterThan(0);
    // Second press mid-jump is rejected.
    const double = applyJump(jumped);
    expect(double.dinoVy).toBe(jumped.dinoVy);
  });

  test("countdown and frozen phases swallow input", () => {
    const counting = beginCountdown(startRun(initialState(0)), TICKS_PER_SECOND);
    expect(actionForKey(counting, "space")).toBe("ignore");
    const frozen = freezeRun(startRun(initialState(0)));
    expect(actionForKey(frozen, "space")).toBe("ignore");
  });
});

describe("dino physics", () => {
  test("countdown decrements one phase per tick and ends in grace", () => {
    let state = beginCountdown(startRun(initialState(0)), TICKS_PER_SECOND);
    const initialTicks = (state.phase as { ticksRemaining: number }).ticksRemaining;
    for (let i = 0; i < initialTicks; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
    }
    expect(state.phase.kind).toBe("grace");
    expect(state.graceCellsLeft).toBe(GRACE_DISTANCE_CELLS);
  });

  test("score does not accumulate during countdown or grace", () => {
    let state = beginCountdown(startRun(initialState(0)), TICKS_PER_SECOND);
    for (let i = 0; i < 100; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
      if (state.phase.kind === "running") break;
    }
    expect(state.score).toBe(0);
  });

  test("score accumulates only while running", () => {
    let state = startRun(initialState(0));
    for (let i = 0; i < 50; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
      // Force the dino to stay grounded to avoid an accidental cactus hit.
      state = { ...state, dinoY: 0, dinoVy: 0 };
      if (state.phase.kind === "gameover") break;
    }
    expect(state.score).toBeGreaterThan(0);
  });

  test("a jump arc returns the dino to the ground", () => {
    let state = applyJump(startRun(initialState(0)));
    let airborneSeen = false;
    for (let i = 0; i < 30; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
      if (state.dinoY > 0) airborneSeen = true;
      if (state.phase.kind === "gameover") break;
    }
    expect(airborneSeen).toBe(true);
    expect(state.dinoY).toBe(0);
  });
});

describe("dino render", () => {
  test("collapsed row formats the high score with leading zeros", () => {
    expect(renderCollapsedRow(7)).toContain("HI 0007");
    expect(renderCollapsedRow(1234)).toContain("HI 1234");
  });

  test("expanded frame matches the row budget", () => {
    const frame = renderExpanded(startRun(initialState(0)));
    expect(frame.length).toBe(EXPANDED_ROWS);
    // Ground line is present and made of `_`.
    expect(frame.some((row) => row.includes("__________"))).toBe(true);
    // Dino glyph sits at DINO_X on the ground row.
    const groundRow = frame.find((row) => row[DINO_X] === "D");
    expect(groundRow).toBeDefined();
  });

  test("frozen overlay tells the user the agent needs them", () => {
    const frozen = freezeRun(startRun(initialState(0)));
    const frame = renderExpanded(frozen);
    expect(frame.some((row) => row.includes("agent needs you"))).toBe(true);
  });
});

// Sanity check: BASE_SPEED is small enough that a tick at base speed
// moves obstacles less than one full cell, which the tick layer relies
// on to keep the collision window honest.
test("BASE_SPEED stays sub-cell", () => {
  expect(BASE_SPEED).toBeLessThan(1);
});
