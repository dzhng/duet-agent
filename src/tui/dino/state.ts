// Pure GameState for the dino panel. No timers, no I/O, no OpenTUI imports.
// All transitions are reducer-style: state in, state out.

/** Default logical width of the playfield in character cells. Used as the
 *  initial value of `GameState.fieldWidth`; the panel updates the live
 *  field width from the renderer on construction and on every resize so
 *  the game fills the available column. */
export const DEFAULT_FIELD_WIDTH = 60;

/** Minimum field width we will render at. Below this the playfield gets
 *  uncomfortably tight for the dino + grace window + spawned obstacles. */
export const MIN_FIELD_WIDTH = 40;

/** Maximum field width we will render at. Above this the obstacles get so
 *  far apart that the game stops feeling like Chrome's dino. The cap is
 *  generous so ultra-wide terminals still look full. */
export const MAX_FIELD_WIDTH = 240;

/** @deprecated Use `state.fieldWidth`. Kept as a re-export of the default
 *  so older call sites and tests continue to compile against a single
 *  width number. */
export const FIELD_WIDTH = DEFAULT_FIELD_WIDTH;

/** Row index of the ground line within the rendered panel (0-indexed from
 *  the top of the 12-row panel). The dino's `y` is measured upward from
 *  here so a positive `y` means "in the air". */
export const GROUND_ROW = 8;

/** Horizontal cell the dino occupies; obstacles scroll past this column. */
export const DINO_X = 6;

/** Gravity applied per tick to `dinoVy`, in cells/tick². Tuned with
 *  `JUMP_VELOCITY` so a single press clears a small cactus and the dino
 *  lands in ~0.45s — matching the snappy feel of Chrome's offline dino
 *  rather than a floaty Mario jump. Peak height ≈ v²/(2g) ≈ 4.9 cells. */
export const GRAVITY = 0.75;

/** Upward velocity applied on a jump press while grounded, in cells/tick.
 *  Combined with `GRAVITY` this gives a tight ~7.2-tick airtime so the
 *  rhythm matches Chrome's game. */
export const JUMP_VELOCITY = 2.7;

/** Base horizontal scroll speed in cells/tick. */
export const BASE_SPEED = 0.6;

/** Cap so the game stays playable on a single jump arc no matter how long
 *  the run lasts. */
export const MAX_SPEED = 1.6;

/** Score gained per advanced tick at base speed. Scaled with current speed
 *  so faster runs score faster, matching Chrome's behavior. */
export const SCORE_PER_TICK = 0.1;

/** Minimum horizontal gap between consecutive obstacles, expressed in
 *  cells, before the spawner is allowed to drop another one. */
export const MIN_OBSTACLE_GAP = 14;

/** Maximum extra gap added on top of the minimum, chosen with a per-spawn
 *  random roll so the cadence does not feel metronomic. */
export const MAX_EXTRA_GAP = 18;

/** Cells of obstacle-free runway granted ahead of the dino on resume after
 *  an automatic freeze. Set to ~1.5s worth of cells at base speed. */
export const GRACE_DISTANCE_CELLS = 14;

export interface Obstacle {
  /** Sub-cell horizontal position. Decreases as the world scrolls left. */
  x: number;
  /** Cactus height in cells. 1 = small, 2 = tall. v1 ships with one size
   *  but the field is in place so a future variant can differ. */
  height: number;
}

export type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "countdown"; ticksRemaining: number }
  | { kind: "grace" }
  | { kind: "frozen" }
  | { kind: "gameover" };

export interface GameState {
  phase: Phase;
  /** Score accumulates only during `running`. Frozen as an integer for the
   *  UI but kept as a float here so sub-tick scaling is preserved. */
  score: number;
  /** Best score observed this process. Hydrated from `~/.duet` at panel
   *  construction; persisted whenever a run ends with `score > highScore`. */
  highScore: number;
  /** Current scroll speed in cells/tick. Ramps from BASE_SPEED toward
   *  MAX_SPEED as score grows. */
  speed: number;
  /** Dino vertical position above the ground in cells. `0` = grounded. */
  dinoY: number;
  /** Dino vertical velocity in cells/tick. Positive = ascending. */
  dinoVy: number;
  /** Obstacles ordered left-to-right by `x`. The spawner appends to the
   *  tail; the tick removes from the head once an obstacle scrolls past
   *  `x < -2`. */
  obstacles: Obstacle[];
  /** Cells of runway still owed to the dino during the post-countdown
   *  grace period. Decremented each tick; transitions back to `running`
   *  when it reaches zero. */
  graceCellsLeft: number;
  /** Cells of horizontal distance until the spawner is allowed to emit
   *  the next obstacle. Decremented each tick the world advances. */
  cellsUntilNextSpawn: number;
  /** Live width of the playfield in cells. The panel keeps this in sync
   *  with the renderer's terminal width on construction and on resize so
   *  the game stretches to fill the available column. Obstacles spawn at
   *  the right edge of this window. */
  fieldWidth: number;
}

export function initialState(
  highScore: number,
  fieldWidth: number = DEFAULT_FIELD_WIDTH,
): GameState {
  return {
    phase: { kind: "idle" },
    score: 0,
    highScore,
    speed: BASE_SPEED,
    dinoY: 0,
    dinoVy: 0,
    obstacles: [],
    graceCellsLeft: 0,
    cellsUntilNextSpawn: MIN_OBSTACLE_GAP,
    fieldWidth: clampFieldWidth(fieldWidth),
  };
}

/** Resize reducer. Called by the panel when the terminal resizes; clamps
 *  to the supported range and trims any obstacles that fell off the new
 *  right edge so a shrink doesn't leave hazards floating in space. */
export function setFieldWidth(state: GameState, fieldWidth: number): GameState {
  const next = clampFieldWidth(fieldWidth);
  if (next === state.fieldWidth) return state;
  // Drop obstacles past the new right edge; the spawner will refill from
  // the new edge on the next tick.
  const obstacles = state.obstacles.filter((o) => o.x < next);
  return { ...state, fieldWidth: next, obstacles };
}

export function clampFieldWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_FIELD_WIDTH;
  return Math.max(MIN_FIELD_WIDTH, Math.min(MAX_FIELD_WIDTH, Math.floor(width)));
}

/** Start a fresh run from `idle` or `gameover`. Preserves `highScore` and
 *  the current `fieldWidth` so resizes during gameover persist into the
 *  next run. */
export function startRun(state: GameState): GameState {
  return {
    ...initialState(state.highScore, state.fieldWidth),
    phase: { kind: "running" },
  };
}

/** Snap to the ground and stop the world. Called from the panel's
 *  `freeze()` so a long agent turn does not leave the dino hanging
 *  mid-jump. */
export function freezeRun(state: GameState): GameState {
  if (state.phase.kind === "frozen" || state.phase.kind === "idle") return state;
  return {
    ...state,
    phase: { kind: "frozen" },
    dinoY: 0,
    dinoVy: 0,
  };
}

/** Begin the 3-2-1 countdown after an automatic freeze ends. The countdown
 *  itself counts down by tick in `tick.ts` so this just seeds the phase. */
export function beginCountdown(state: GameState, ticksPerSecond: number): GameState {
  return {
    ...state,
    phase: { kind: "countdown", ticksRemaining: ticksPerSecond * 3 },
  };
}

/** Transition from countdown into the grace gap. The grace gap pushes any
 *  obstacle inside `GRACE_DISTANCE_CELLS` of the dino's column out to the
 *  far edge of the grace window so the run resumes without an unfair hit. */
export function beginGrace(state: GameState): GameState {
  const graceEdge = DINO_X + GRACE_DISTANCE_CELLS;
  const shifted = state.obstacles.map((o) => (o.x < graceEdge ? { ...o, x: graceEdge + 2 } : o));
  return {
    ...state,
    obstacles: shifted,
    phase: { kind: "grace" },
    graceCellsLeft: GRACE_DISTANCE_CELLS,
  };
}

export function endRunOnHit(state: GameState): GameState {
  const finalScore = Math.floor(state.score);
  return {
    ...state,
    phase: { kind: "gameover" },
    highScore: Math.max(state.highScore, finalScore),
  };
}

export function isWorldAdvancing(phase: Phase): boolean {
  return phase.kind === "running" || phase.kind === "grace";
}
