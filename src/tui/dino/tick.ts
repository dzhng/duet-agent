// One physics tick. Pure: takes current state + a random source and the
// per-tick cadence, returns the next state. The panel owns the timer that
// calls this; tests call it directly with a seeded RNG.

import {
  BASE_SPEED,
  DINO_X,
  GRAVITY,
  MAX_EXTRA_GAP,
  MAX_SPEED,
  MIN_OBSTACLE_GAP,
  SCORE_PER_TICK,
  beginGrace,
  endRunOnHit,
  isWorldAdvancing,
  type GameState,
  type Obstacle,
} from "./state.js";

export interface TickDeps {
  /** Returns a float in [0, 1). Injected so tests can seed the spawner. */
  random: () => number;
  /** Ticks per second the panel is calling us at; used to step the
   *  countdown phase down in wall-clock-aligned increments. */
  ticksPerSecond: number;
}

export function tick(state: GameState, deps: TickDeps): GameState {
  if (state.phase.kind === "countdown") {
    const ticksRemaining = state.phase.ticksRemaining - 1;
    if (ticksRemaining <= 0) {
      // Countdown finished; enter the grace gap. `beginGrace` shifts any
      // nearby obstacles to the edge of the grace window so the dino does
      // not wake up onto a cactus.
      return beginGrace(state);
    }
    return { ...state, phase: { kind: "countdown", ticksRemaining } };
  }

  if (
    state.phase.kind === "idle" ||
    state.phase.kind === "gameover" ||
    state.phase.kind === "frozen"
  ) {
    return state;
  }

  // Physics for running / grace. The dino integrates regardless so a jump
  // initiated mid-grace still arcs correctly.
  const nextDinoVy = state.dinoVy - GRAVITY;
  let nextDinoY = state.dinoY + state.dinoVy;
  let landedVy = nextDinoVy;
  if (nextDinoY <= 0) {
    nextDinoY = 0;
    landedVy = 0;
  }

  // World scroll. Running ticks accumulate score and ramp speed; grace
  // ticks scroll obstacles by but score stays pinned (preventing pause
  // farming) and the speed ramp is paused too.
  const advancingWorld = isWorldAdvancing(state.phase);
  const nextSpeed =
    state.phase.kind === "running"
      ? Math.min(MAX_SPEED, BASE_SPEED + state.score * 0.0008)
      : state.speed;
  const scroll = advancingWorld ? nextSpeed : 0;

  let nextObstacles: Obstacle[] = state.obstacles
    .map((o) => ({ ...o, x: o.x - scroll }))
    .filter((o) => o.x > -2);

  // Spawner. Decrements the countdown to the next spawn by the scroll
  // distance, then drops an obstacle at the right edge when it hits zero.
  let cellsUntilNextSpawn = state.cellsUntilNextSpawn - scroll;
  if (advancingWorld && cellsUntilNextSpawn <= 0) {
    nextObstacles = [...nextObstacles, { x: 60, height: 1 }];
    cellsUntilNextSpawn = MIN_OBSTACLE_GAP + deps.random() * MAX_EXTRA_GAP;
  }

  // Collision: only during `running`. The grace phase explicitly ignores
  // collisions for `graceCellsLeft` cells so the resume is fair.
  const collided =
    state.phase.kind === "running" &&
    nextObstacles.some((o) => {
      const dx = o.x - DINO_X;
      return dx > -1 && dx < 1 && nextDinoY < o.height;
    });

  if (collided) {
    return endRunOnHit({
      ...state,
      obstacles: nextObstacles,
      dinoY: nextDinoY,
      dinoVy: landedVy,
      speed: nextSpeed,
      cellsUntilNextSpawn,
    });
  }

  // Grace transition back to running once enough cells have scrolled.
  if (state.phase.kind === "grace") {
    const graceCellsLeft = state.graceCellsLeft - scroll;
    if (graceCellsLeft <= 0) {
      return {
        ...state,
        phase: { kind: "running" },
        obstacles: nextObstacles,
        dinoY: nextDinoY,
        dinoVy: landedVy,
        speed: nextSpeed,
        graceCellsLeft: 0,
        cellsUntilNextSpawn,
      };
    }
    return {
      ...state,
      obstacles: nextObstacles,
      dinoY: nextDinoY,
      dinoVy: landedVy,
      speed: nextSpeed,
      graceCellsLeft,
      cellsUntilNextSpawn,
    };
  }

  // Plain running tick.
  return {
    ...state,
    obstacles: nextObstacles,
    dinoY: nextDinoY,
    dinoVy: landedVy,
    speed: nextSpeed,
    score: state.score + SCORE_PER_TICK * (nextSpeed / BASE_SPEED),
    cellsUntilNextSpawn,
  };
}
