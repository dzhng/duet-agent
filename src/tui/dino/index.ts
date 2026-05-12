// OpenTUI panel that hosts the dino game. Owns the tick timer, the
// `BoxRenderable` mounted into the layout, and the freeze/resume lifecycle
// that the StatusController drives via its `onRunningChange` hook.
//
// Lifecycle contract (matches the spec we agreed in design):
//   - toggle()        : user pressed Ctrl-G; expand/collapse the panel.
//   - freeze()        : agent flipped to needs-user; snap dino to ground
//                       and stop the world. No-op when collapsed.
//   - resume()        : agent flipped to busy; start the 3-2-1 countdown
//                       followed by a grace gap. No-op when collapsed or
//                       when no run is in progress.
//   - handleKey(key)  : input router forwards keystrokes here while the
//                       panel is expanded and the agent is busy. Returns
//                       true when the key was consumed.
//   - destroy()       : tear down the tick timer; persist high score.

import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { COLORS } from "../theme.js";
import { actionForKey, applyJump, applyStart } from "./input.js";
import {
  loadHighScore,
  loadPanelState,
  savePanelState,
  saveHighScore,
  type PanelOpenState,
} from "./persistence.js";
import { COLLAPSED_ROWS, EXPANDED_ROWS, renderCollapsedRow, renderExpanded } from "./render.js";
import { beginCountdown, freezeRun, initialState, type GameState } from "./state.js";
import { tick } from "./tick.js";

/** Cadence of the physics loop. Chosen high enough that a jump arc feels
 *  smooth in a terminal but low enough that the redraw cost is negligible
 *  (15 fps ≈ 67ms per frame). The countdown layer uses this same value to
 *  size the 3-2-1 phase. */
const TICKS_PER_SECOND = 15;
const TICK_INTERVAL_MS = Math.round(1000 / TICKS_PER_SECOND);

export interface DinoPanelOptions {
  renderer: CliRenderer;
}

export interface DinoPanel {
  /** The mounted box; callers attach it to their layout. */
  readonly view: BoxRenderable;
  /** True when the panel is in its 12-row expanded form. */
  isExpanded(): boolean;
  /** Toggle between expanded and collapsed. Persists state. */
  toggle(): void;
  /** Agent went busy → resume the game with countdown + grace. */
  resume(): void;
  /** Agent flipped to needs-user → freeze the world. */
  freeze(): void;
  /** Route a keystroke to the game. Returns true when consumed. */
  handleKey(keyName: string | undefined): boolean;
  /** Persist high score and stop timers. */
  destroy(): void;
}

export function createDinoPanel(opts: DinoPanelOptions): DinoPanel {
  const { renderer } = opts;
  const initialOpen: PanelOpenState = loadPanelState();
  let expanded = initialOpen === "open";
  let state: GameState = initialState(loadHighScore());
  // Tracks whether the most recent freeze was caused by the agent needing
  // input (so resume runs the 3-2-1 + grace gap) vs. a manual collapse
  // (so re-expand resumes instantly per the spec).
  let frozenByAgent = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  // Last persisted high score, so we only write on improvement. Hydrated
  // from disk at construction time.
  let persistedHighScore = state.highScore;

  const view = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexShrink: 0,
    border: false,
  });
  // One TextRenderable per displayed row. The expanded layout reserves
  // EXPANDED_ROWS rows; collapsed reuses the first row and hides the
  // rest. Building a fixed row pool avoids reflowing the box on every
  // frame.
  const rows: TextRenderable[] = Array.from({ length: EXPANDED_ROWS }, () => {
    const row = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.hint,
      height: 1,
      flexShrink: 0,
      selectable: false,
    });
    view.add(row);
    return row;
  });
  syncVisibility();
  paint();

  function isExpanded(): boolean {
    return expanded;
  }

  function toggle(): void {
    expanded = !expanded;
    savePanelState(expanded ? "open" : "closed");
    if (expanded) {
      // Re-expanding after a manual collapse during agent-busy resumes
      // instantly — the user explicitly chose to peek away, so the
      // countdown would be friction rather than help.
      if (state.phase.kind === "frozen" && !frozenByAgent) {
        state = { ...state, phase: { kind: "running" } };
      }
    } else {
      // Collapsing while running snaps the world quiet without ending the
      // run; the user can re-expand and pick up where they left off.
      if (state.phase.kind === "running" || state.phase.kind === "grace") {
        state = freezeRun(state);
        frozenByAgent = false;
      }
      stopTicker();
    }
    syncVisibility();
    paint();
    if (expanded && stateNeedsTicking()) startTicker();
  }

  function resume(): void {
    if (!expanded) return;
    // No run in progress → nothing to resume; the user starts a fresh run
    // themselves by pressing space.
    if (state.phase.kind !== "frozen") return;
    if (frozenByAgent) {
      state = beginCountdown(state, TICKS_PER_SECOND);
    } else {
      state = { ...state, phase: { kind: "running" } };
    }
    frozenByAgent = false;
    startTicker();
    paint();
  }

  function freeze(): void {
    frozenByAgent = true;
    state = freezeRun(state);
    stopTicker();
    paint();
  }

  function handleKey(keyName: string | undefined): boolean {
    if (!expanded) return false;
    const action = actionForKey(state, keyName);
    if (action === "ignore") return false;
    if (action === "jump") {
      state = applyJump(state);
    } else if (action === "start") {
      state = applyStart(state);
      // Starting a run after a death needs the timer running again.
      startTicker();
    }
    paint();
    return true;
  }

  function destroy(): void {
    stopTicker();
    if (state.highScore > persistedHighScore) {
      saveHighScore(state.highScore);
      persistedHighScore = state.highScore;
    }
  }

  function stateNeedsTicking(): boolean {
    return (
      state.phase.kind === "running" ||
      state.phase.kind === "grace" ||
      state.phase.kind === "countdown"
    );
  }

  function startTicker(): void {
    if (ticker !== undefined) return;
    if (!stateNeedsTicking()) return;
    ticker = setInterval(() => {
      state = tick(state, { random: Math.random, ticksPerSecond: TICKS_PER_SECOND });
      if (state.highScore > persistedHighScore) {
        saveHighScore(state.highScore);
        persistedHighScore = state.highScore;
      }
      if (!stateNeedsTicking()) stopTicker();
      paint();
    }, TICK_INTERVAL_MS);
  }

  function stopTicker(): void {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function syncVisibility(): void {
    // Visible row count: expanded shows all EXPANDED_ROWS; collapsed
    // shows only the first row with the "press Ctrl-G  HI 0142" hint.
    for (let i = 0; i < rows.length; i++) {
      rows[i].visible = expanded || i < COLLAPSED_ROWS;
    }
  }

  function paint(): void {
    if (expanded) {
      const frame = renderExpanded(state);
      for (let i = 0; i < rows.length; i++) {
        rows[i].content = frame[i] ?? "";
      }
    } else {
      rows[0].content = renderCollapsedRow(state.highScore);
      for (let i = 1; i < rows.length; i++) rows[i].content = "";
    }
  }

  return {
    view,
    isExpanded,
    toggle,
    resume,
    freeze,
    handleKey,
    destroy,
  };
}
