// Keystroke → game action. Pure so the panel can route keys through this
// without dragging OpenTUI key types into the reducer layer.

import type { GameState } from "./state.js";
import { JUMP_VELOCITY, startRun } from "./state.js";

export type DinoAction = "jump" | "start" | "ignore";

/** Names of keys that, when game is in a state that accepts input, trigger
 *  a jump. Matches Chrome's dino: Space and ArrowUp. We allow `up` as a
 *  fallback because OpenTUI normalizes the arrow key to `name: "up"`. */
const JUMP_KEYS = new Set(["space", "up"]);

/** Returns the action implied by a key press for the current game state.
 *  Returns `"ignore"` for keys the panel should let bubble (so e.g. typing
 *  letters while the panel is collapsed never gets eaten). */
export function actionForKey(state: GameState, keyName: string | undefined): DinoAction {
  if (!keyName) return "ignore";
  if (state.phase.kind === "idle" || state.phase.kind === "gameover") {
    // Any of the jump keys also acts as "start a run" so the user does not
    // need a separate start key after a death.
    if (JUMP_KEYS.has(keyName) || keyName === "return" || keyName === "enter") return "start";
    return "ignore";
  }
  if (state.phase.kind === "running" || state.phase.kind === "grace") {
    if (JUMP_KEYS.has(keyName)) return "jump";
    return "ignore";
  }
  // countdown / frozen swallow input so the user cannot pre-jump and then
  // land on a cactus the instant the world unfreezes.
  return "ignore";
}

/** Apply a `jump` action: only takes effect when the dino is grounded so
 *  the player cannot double-jump. */
export function applyJump(state: GameState): GameState {
  if (state.dinoY > 0 || state.dinoVy !== 0) return state;
  return { ...state, dinoVy: JUMP_VELOCITY };
}

/** Apply a `start` action: begin a fresh run from `idle`/`gameover`. */
export function applyStart(state: GameState): GameState {
  if (state.phase.kind !== "idle" && state.phase.kind !== "gameover") return state;
  return startRun(state);
}
