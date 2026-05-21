// Pure-core tests for the dino panel's reducer + physics layer. No file
// I/O and no OpenTUI imports, so these run on the host without
// `testIfDocker`. The wiring layer (panel, key handlers, layout) is
// covered by the existing TUI rendering tests once the panel is mounted.

import { describe, expect, test } from "bun:test";
import { actionForKey, applyJump, applyStart } from "../src/tui/dino/input.js";
import { COLLAPSED_ROWS, renderExpanded, EXPANDED_ROWS } from "../src/tui/dino/render.js";
import { panelVisibleRowCount } from "../src/tui/dino/visibility.js";
import {
  BASE_SPEED,
  DEFAULT_FIELD_WIDTH,
  DINO_X,
  GRACE_DISTANCE_CELLS,
  MAX_FIELD_WIDTH,
  MIN_FIELD_WIDTH,
  beginCountdown,
  beginGrace,
  clampFieldWidth,
  expandResumeKind,
  freezeRun,
  initialState,
  setFieldWidth,
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
  test("up starts a run from idle, space does not", () => {
    const idle = initialState(0);
    expect(actionForKey(idle, "up")).toBe("start");
    // Arrow-only controls: the spacebar is owned by the composer.
    expect(actionForKey(idle, "space")).toBe("ignore");
    expect(applyStart(idle).phase.kind).toBe("running");
  });

  test("up jumps while running, but only from the ground", () => {
    const running = startRun(initialState(0));
    expect(actionForKey(running, "up")).toBe("jump");
    expect(actionForKey(running, "space")).toBe("ignore");
    const jumped = applyJump(running);
    expect(jumped.dinoVy).toBeGreaterThan(0);
    // Second press mid-jump is rejected.
    const double = applyJump(jumped);
    expect(double.dinoVy).toBe(jumped.dinoVy);
  });

  test("countdown and frozen phases swallow input", () => {
    const counting = beginCountdown(startRun(initialState(0)), TICKS_PER_SECOND);
    expect(actionForKey(counting, "up")).toBe("ignore");
    const frozen = freezeRun(startRun(initialState(0)));
    expect(actionForKey(frozen, "up")).toBe("ignore");
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
  test("collapsed panel reserves zero rows so it never steals a line under the transcript", () => {
    expect(COLLAPSED_ROWS).toBe(0);
  });

  test("expanded frame matches the row budget", () => {
    const frame = renderExpanded(startRun(initialState(0)));
    expect(frame.length).toBe(EXPANDED_ROWS);
    // Ground line is present and made of `_`.
    expect(frame.some((row) => row.includes("__________"))).toBe(true);
    // Dino sprite is anchored at DINO_X. The middle row of the sprite
    // carries the unmistakable head shape ("/_)") which lets us verify
    // the dino landed on the playfield without locking the assertion to
    // any single character.
    const middleSprite = frame.find((row) => row.slice(DINO_X, DINO_X + 4) === " /_)");
    expect(middleSprite).toBeDefined();
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

describe("dino responsive width", () => {
  test("clampFieldWidth clamps to [MIN, MAX] and floors floats", () => {
    expect(clampFieldWidth(10)).toBe(MIN_FIELD_WIDTH);
    expect(clampFieldWidth(9999)).toBe(MAX_FIELD_WIDTH);
    expect(clampFieldWidth(123.7)).toBe(123);
    expect(clampFieldWidth(Number.NaN)).toBe(DEFAULT_FIELD_WIDTH);
  });

  test("initialState honors the supplied field width", () => {
    expect(initialState(0, 120).fieldWidth).toBe(120);
    expect(initialState(0).fieldWidth).toBe(DEFAULT_FIELD_WIDTH);
  });

  test("setFieldWidth drops obstacles past the new right edge", () => {
    const running = startRun(initialState(0, 120));
    const stocked = {
      ...running,
      obstacles: [
        { x: 30, height: 1 },
        { x: 80, height: 1 },
        { x: 110, height: 1 },
      ],
    };
    const shrunk = setFieldWidth(stocked, 60);
    expect(shrunk.fieldWidth).toBe(60);
    expect(shrunk.obstacles.map((o) => o.x)).toEqual([30]);
  });

  test("renderExpanded stretches the ground line to the field width", () => {
    const frame = renderExpanded(startRun(initialState(0, 100)));
    const groundRow = frame.find((row) => row.startsWith("_"));
    expect(groundRow).toBeDefined();
    expect(groundRow!.length).toBe(100);
  });

  test("startRun preserves fieldWidth across runs", () => {
    const wide = initialState(0, 150);
    expect(startRun(wide).fieldWidth).toBe(150);
  });

  test("first obstacle of a run spawns within the lead-in window on wide fields", () => {
    // Wide field: 200 cells. Without the cap the first obstacle would
    // spawn at x=200; with the cap it should land at DINO_X + 36 = 42.
    let state = startRun(initialState(0, 200));
    // Run the world forward until the first obstacle appears. Cap the
    // loop generously so a regression can't hang the test.
    for (let i = 0; i < 200 && state.obstacles.length === 0; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
    }
    expect(state.obstacles.length).toBeGreaterThan(0);
    // 6 (DINO_X) + 36 (FIRST_OBSTACLE_MAX_DISTANCE) = 42. Allow a small
    // tolerance because the spawn fires the tick `cellsUntilNextSpawn`
    // crosses zero, so a fractional cell of scroll happens that same
    // tick.
    expect(state.obstacles[0].x).toBeLessThanOrEqual(42);
    expect(state.obstacles[0].x).toBeGreaterThan(40);
  });

  test("collapsed panel reserves zero rows", () => {
    // Collapsed is always invisible: the Ctrl-G tease lives in the input
    // placeholder, not in a reserved row.
    expect(panelVisibleRowCount(false)).toBe(COLLAPSED_ROWS);
    expect(COLLAPSED_ROWS).toBe(0);
  });

  test("expanded panel shows the full game whether the agent is busy or idle", () => {
    // Ctrl-G must work at any time — the placeholder advertises "hit
    // Ctrl-G if you're bored", so at-rest toggles have to bring up the
    // game instead of silently no-op'ing.
    expect(panelVisibleRowCount(true)).toBe(EXPANDED_ROWS);
  });

  test("expandResumeKind picks countdown after an agent freeze and run after a manual collapse", () => {
    // Repro for the answer-then-Ctrl-G bug: the agent freezes the run on
    // needs-user; when the panel was collapsed at the moment the agent
    // came back, `resume()` no-op'd. The user then re-opens with Ctrl-G
    // and expects the 3-2-1 countdown to take it from there.
    expect(expandResumeKind({ kind: "frozen" }, true)).toBe("countdown");
    expect(expandResumeKind({ kind: "frozen" }, false)).toBe("run");
    // Nothing in flight → toggling open must not invent a phase.
    expect(expandResumeKind({ kind: "idle" }, true)).toBe("noop");
    expect(expandResumeKind({ kind: "running" }, false)).toBe("noop");
    expect(expandResumeKind({ kind: "gameover" }, false)).toBe("noop");
  });

  test("first obstacle on a narrow field still spawns at the right edge", () => {
    // Narrow field (40 cells) is inside the cap, so behavior is unchanged.
    let state = startRun(initialState(0, 40));
    for (let i = 0; i < 200 && state.obstacles.length === 0; i++) {
      state = tick(state, { random: fixedRandom, ticksPerSecond: TICKS_PER_SECOND });
    }
    expect(state.obstacles.length).toBeGreaterThan(0);
    expect(state.obstacles[0].x).toBeLessThanOrEqual(40);
    expect(state.obstacles[0].x).toBeGreaterThan(38);
  });
});
