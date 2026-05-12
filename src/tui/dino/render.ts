// state → string[]. Pure ASCII; no OpenTUI imports so tests can snapshot
// the rendered frame as plain strings.

import { DINO_X, FIELD_WIDTH, GROUND_ROW, type GameState } from "./state.js";

/** Total rendered rows of the expanded panel: title + 10 playfield rows +
 *  status row = 12 rows when expanded. Collapsed = 1 row. */
export const EXPANDED_ROWS = 12;
export const COLLAPSED_ROWS = 1;
export const PLAYFIELD_ROWS = 10;

/** Single-row "press Ctrl-G  HI 0142" hint shown when the panel is
 *  collapsed but the user has opened it at least once this session. */
export function renderCollapsedRow(highScore: number): string {
  return `▶ Ctrl-G to play  ·  HI ${pad4(highScore)}`;
}

/** Full 12-row expanded panel. The phase determines which overlay (idle
 *  splash, countdown numerals, dim "agent needs you" hint, gameover
 *  banner) is composited on top of the playfield. */
export function renderExpanded(state: GameState): string[] {
  const rows = buildPlayfield(state);
  const title = renderTitle(state);
  const statusRow = renderStatusRow(state);
  const overlay = renderOverlay(state);
  if (overlay) {
    // Overlay replaces a centered slice of the playfield rows; the dino
    // and obstacles still show around it so the user sees what they will
    // wake up to.
    overlayRows(rows, overlay);
  }
  return [title, ...rows, statusRow];
}

function renderTitle(state: GameState): string {
  const score = pad4(Math.floor(state.score));
  const hi = pad4(state.highScore);
  return `  duet dino  ·  HI ${hi}  ·  ${score}`;
}

function renderStatusRow(state: GameState): string {
  switch (state.phase.kind) {
    case "idle":
      return "  press space to start  ·  Ctrl-G to close";
    case "running":
      return "  space / ↑ to jump  ·  Ctrl-G to close";
    case "grace":
      return "  …";
    case "countdown":
      return "  resuming…";
    case "frozen":
      return "  ▲ agent needs you — answer above";
    case "gameover":
      return "  game over  ·  space to retry  ·  Ctrl-G to close";
  }
}

function buildPlayfield(state: GameState): string[] {
  const rows: string[][] = Array.from({ length: PLAYFIELD_ROWS }, () =>
    Array.from({ length: FIELD_WIDTH }, () => " "),
  );
  // Ground line.
  const groundIndex = Math.min(GROUND_ROW, PLAYFIELD_ROWS - 1);
  for (let x = 0; x < FIELD_WIDTH; x++) rows[groundIndex][x] = "_";

  // Obstacles. Cactus is drawn as "#" stacked vertically, anchored at the
  // ground line. A 1-cell-wide column keeps collision and rendering in
  // exact agreement.
  for (const o of state.obstacles) {
    const col = Math.round(o.x);
    if (col < 0 || col >= FIELD_WIDTH) continue;
    for (let h = 0; h < o.height; h++) {
      const row = groundIndex - 1 - h;
      if (row >= 0) rows[row][col] = "#";
    }
  }

  // Dino. Floor-rounded `y` so a sub-cell hop still visibly lifts off; the
  // sprite is one cell, matching the obstacle column width so collision
  // logic is honest. The character changes when airborne so the user can
  // confirm a jump landed.
  const dinoRow = groundIndex - Math.max(0, Math.floor(state.dinoY));
  if (dinoRow >= 0 && dinoRow < PLAYFIELD_ROWS) {
    const grounded = state.dinoY === 0;
    rows[dinoRow][DINO_X] = grounded ? "D" : "d";
  }

  return rows.map((r) => r.join(""));
}

function renderOverlay(state: GameState): string[] | undefined {
  if (state.phase.kind === "countdown") {
    // Big numeral derived from ticksRemaining. The tick layer counts down
    // in whole-second blocks of `ticksPerSecond` so dividing reproduces 3
    // → 2 → 1 cleanly regardless of the actual cadence.
    const seconds = Math.ceil(state.phase.ticksRemaining / 15);
    return bigNumeral(seconds);
  }
  if (state.phase.kind === "frozen") {
    return ["agent needs you", "answer the prompt above"];
  }
  if (state.phase.kind === "gameover") {
    return ["game over", `score ${Math.floor(state.score)}`];
  }
  return undefined;
}

function overlayRows(rows: string[], overlay: string[]): void {
  const startRow = Math.max(0, Math.floor((rows.length - overlay.length) / 2));
  for (let i = 0; i < overlay.length; i++) {
    const target = startRow + i;
    if (target >= rows.length) break;
    const line = overlay[i];
    const startCol = Math.max(0, Math.floor((FIELD_WIDTH - line.length) / 2));
    const before = rows[target].slice(0, startCol);
    const after = rows[target].slice(startCol + line.length);
    rows[target] = (before + line + after).slice(0, FIELD_WIDTH);
  }
}

function bigNumeral(n: number): string[] {
  // Stylized but ASCII-only so it carries the 8-bit feel without leaning
  // on Unicode block characters that render at inconsistent widths.
  const label = n > 0 ? String(n) : "GO!";
  return [`>>> ${label} <<<`];
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}
