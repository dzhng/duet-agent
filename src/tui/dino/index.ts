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
import { SIDEBAR_WIDTH } from "../sidebar.js";
import { COLORS } from "../theme.js";
import { actionForKey, applyJump, applyStart } from "./input.js";
import { loadHighScore, saveHighScore } from "./persistence.js";
import { EXPANDED_ROWS, renderExpanded } from "./render.js";
import { panelVisibleRowCount } from "./visibility.js";
import {
  beginCountdown,
  expandResumeKind,
  freezeRun,
  initialState,
  setFieldWidth,
  type GameState,
} from "./state.js";
import { tick } from "./tick.js";

/** Horizontal chrome around the dino panel: the panel sits inside the main
 *  layout column, which itself sits to the left of the sidebar. We deduct
 *  the sidebar plus a few cells of frame padding to land on a field width
 *  that fills the available column without overflowing it. */
const PANEL_CHROME_COLUMNS = 4;

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
  /** True when game keys (space, ArrowUp) should route to the dino
   *  panel instead of the composer. Only meaningful while expanded. */
  isGameFocused(): boolean;
  /** Cycle through: collapsed → expanded+playing → expanded+typing →
   *  collapsed. Lets the user keep a half-typed follow-up in the
   *  composer and still toggle game keys back on without erasing it. */
  toggle(): void;
  /** Agent went busy → resume the game with countdown + grace. */
  resume(): void;
  /** Agent flipped to needs-user → freeze the world. */
  freeze(): void;
  /** Track the agent's busy/idle signal so Ctrl-G is only meaningful
   *  while the agent is working — at rest the panel takes no vertical
   *  space and the toggle is a no-op. */
  setAgentBusy(busy: boolean): void;
  /** Route a keystroke to the game. Returns true when consumed. */
  handleKey(keyName: string | undefined): boolean;
  /** Persist high score and stop timers. */
  destroy(): void;
}

export function createDinoPanel(opts: DinoPanelOptions): DinoPanel {
  const { renderer } = opts;
  // The panel is collapsed by default and re-collapses every time the
  // agent goes idle. "Hint only" is the starting point for every busy
  // cycle; if the user wants the game they toggle it open each time.
  // We do not persist expanded state across sessions or across busy
  // cycles — the simpler contract is more predictable.
  let expanded = false;
  // When expanded, tracks whether game keys (space, ArrowUp) belong to
  // the dino or to the composer. Defaults to true on every expand so
  // Ctrl-G straight into a playable game; flipping to false via a
  // second Ctrl-G keeps the panel visible but releases the keys back
  // to the textarea so the user can type a follow-up without
  // collapsing the game.
  let gameFocused = true;
  let state: GameState = initialState(loadHighScore(), computeFieldWidth(renderer));
  // Tracks whether the most recent freeze was caused by the agent needing
  // input (so resume runs the 3-2-1 + grace gap) vs. a manual collapse
  // (so re-expand resumes instantly per the spec).
  let frozenByAgent = false;
  // Mirrors the StatusController running signal. Ctrl-G is only
  // accepted while this is true; at idle the panel is invisible and
  // reserves no rows.
  let agentBusy = false;
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

  // Resize handler. The renderer fires "resize" on terminal size changes;
  // we recompute the playfield width and let the next paint stretch the
  // ground line / obstacles to the new column. We keep a reference so the
  // panel's `destroy()` can detach it on teardown.
  const handleResize = (): void => {
    const next = computeFieldWidth(renderer);
    if (next === state.fieldWidth) return;
    state = setFieldWidth(state, next);
    paint();
  };
  renderer.on("resize", handleResize);

  function isExpanded(): boolean {
    return expanded;
  }

  function isGameFocused(): boolean {
    return expanded && gameFocused;
  }

  function toggle(): void {
    // The dino panel is a "while-you-wait" affordance: it only exists
    // while the agent is actually busy. At rest there is no hint and no
    // toggle — Ctrl-G is a no-op so a fresh `duet` session is clean.
    if (!agentBusy) return;
    // Three-step cycle so the user can toggle keystroke ownership
    // without losing what they typed:
    //   collapsed              → expanded + game-focused
    //   expanded + game        → expanded + composer-focused (typing)
    //   expanded + composer    → collapsed
    if (!expanded) {
      expanded = true;
      gameFocused = true;
    } else if (gameFocused) {
      // Stay expanded; just release keys to the composer. The game
      // keeps animating in the background so the user sees obstacles
      // approach while they type.
      gameFocused = false;
      syncVisibility();
      paint();
      return;
    } else {
      expanded = false;
      gameFocused = true;
    }
    if (expanded) {
      // Re-expanding into a frozen run: if the agent caused the freeze
      // (needs-user → answered → busy again, but `resume()` no-op'd
      // because the panel was collapsed), run the 3-2-1 + grace gap the
      // live resume path uses. If the user collapsed manually, resume
      // instantly — they explicitly chose to peek away.
      const kind = expandResumeKind(state.phase, frozenByAgent);
      if (kind === "countdown") {
        state = beginCountdown(state, TICKS_PER_SECOND);
        frozenByAgent = false;
      } else if (kind === "run") {
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

  function setAgentBusy(busy: boolean): void {
    if (agentBusy === busy) return;
    agentBusy = busy;
    // The game is strictly opt-in: the panel never auto-expands. The
    // Ctrl-G tease lives in the input placeholder, and the user has to
    // press it themselves to bring up the playfield.
    // When the agent goes idle, snap the panel back to collapsed so
    // the next busy cycle starts invisible rather than re-appearing
    // already expanded. The user opts back in by pressing Ctrl-G.
    if (!busy) {
      expanded = false;
      gameFocused = true;
    }
    syncVisibility();
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
    renderer.off("resize", handleResize);
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
    const visibleRows = panelVisibleRowCount(expanded, agentBusy);
    for (let i = 0; i < rows.length; i++) {
      rows[i].visible = i < visibleRows;
    }
  }

  function paint(): void {
    // At rest the panel is invisible; skip painting entirely so the row
    // contents stay empty and no chrome leaks into the layout.
    if (!agentBusy) {
      for (const row of rows) row.content = "";
      return;
    }
    if (expanded) {
      const frame = renderExpanded(state, gameFocused);
      for (let i = 0; i < rows.length; i++) {
        rows[i].content = frame[i] ?? "";
      }
    } else {
      // Collapsed reserves zero rows; clear any stale content so the
      // pool stays tidy when the next expand reuses it.
      for (const row of rows) row.content = "";
    }
  }

  return {
    view,
    isExpanded,
    isGameFocused,
    toggle,
    resume,
    freeze,
    setAgentBusy,
    handleKey,
    destroy,
  };
}

/** Compute the current playfield width from the renderer's terminal size.
 *  The panel sits in the main layout column to the left of the sidebar, so
 *  we deduct the sidebar plus a small chrome margin and let `setFieldWidth`
 *  clamp into the supported [MIN_FIELD_WIDTH, MAX_FIELD_WIDTH] range. */
function computeFieldWidth(renderer: CliRenderer): number {
  const terminal = renderer.terminalWidth;
  if (!Number.isFinite(terminal) || terminal <= 0) return 0; // clamped by setFieldWidth
  return terminal - SIDEBAR_WIDTH - PANEL_CHROME_COLUMNS;
}
