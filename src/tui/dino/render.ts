// state → string[]. Pure ASCII; no OpenTUI imports so tests can snapshot
// the rendered frame as plain strings.

import { DINO_X, GROUND_ROW, type GameState } from "./state.js";

/** Total rendered rows of the expanded panel: title + 10 playfield rows +
 *  status row = 12 rows when expanded. Collapsed = 1 row. */
export const EXPANDED_ROWS = 12;
export const COLLAPSED_ROWS = 1;
export const PLAYFIELD_ROWS = 10;

/** Width of the dino sprite in cells. Anchored at `DINO_X` (left edge). */
export const DINO_WIDTH = 4;
/** Height of the dino sprite in rows; feet sit on the ground row, so the
 *  body extends up `DINO_HEIGHT - 1` rows above ground when grounded. */
export const DINO_HEIGHT = 3;

// Tiny T-rex sprites in pure ASCII so they line up cleanly in any
// terminal. The right edge points in the direction of travel: head and
// snout to the right, tail to the left. Two run poses alternate while
// grounded so the legs visibly cycle; a third pose is used mid-air.
//
// Each sprite is exactly DINO_HEIGHT rows by DINO_WIDTH cols. Empty
// cells use a literal space so the sprite never accidentally erases
// neighboring playfield characters.
const DINO_RUN_A: readonly string[] = ["  __", " /_)", " /\\ "];
const DINO_RUN_B: readonly string[] = ["  __", " /_)", " \\/ "];
const DINO_JUMP: readonly string[] = ["  __", " /_)", " || "];

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
  const width = state.fieldWidth;
  const rows: string[][] = Array.from({ length: PLAYFIELD_ROWS }, () =>
    Array.from({ length: width }, () => " "),
  );
  // Ground line.
  const groundIndex = Math.min(GROUND_ROW, PLAYFIELD_ROWS - 1);
  for (let x = 0; x < width; x++) rows[groundIndex][x] = "_";

  // Obstacles. Cactus is drawn as "#" stacked vertically, anchored at the
  // ground line. A 1-cell-wide column keeps collision and rendering in
  // exact agreement.
  for (const o of state.obstacles) {
    const col = Math.round(o.x);
    if (col < 0 || col >= width) continue;
    for (let h = 0; h < o.height; h++) {
      const row = groundIndex - 1 - h;
      if (row >= 0) rows[row][col] = "#";
    }
  }

  // Dino. Multi-row T-rex sprite anchored at `DINO_X`, with feet on the
  // ground row when grounded. Floor-rounded `y` so a sub-cell hop still
  // visibly lifts off. The grounded pose alternates between two leg
  // positions so the dino looks like it's running; airborne uses the
  // tucked-legs jump sprite so the user can confirm a jump landed.
  const grounded = state.dinoY === 0;
  const sprite = grounded
    ? // Alternate legs every ~2 score units so the cadence reads as
      // running rather than flickering at every frame.
      Math.floor(state.score * 2) % 2 === 0
      ? DINO_RUN_A
      : DINO_RUN_B
    : DINO_JUMP;
  const feetRow = groundIndex - Math.max(0, Math.floor(state.dinoY));
  for (let dy = 0; dy < sprite.length; dy++) {
    const targetRow = feetRow - (sprite.length - 1 - dy);
    if (targetRow < 0 || targetRow >= PLAYFIELD_ROWS) continue;
    const line = sprite[dy];
    for (let dx = 0; dx < line.length; dx++) {
      const ch = line[dx];
      if (ch === " ") continue; // sprite holes leave the playfield intact
      const col = DINO_X + dx;
      if (col < 0 || col >= width) continue;
      rows[targetRow][col] = ch;
    }
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
  const width = rows[0]?.length ?? 0;
  const startRow = Math.max(0, Math.floor((rows.length - overlay.length) / 2));
  for (let i = 0; i < overlay.length; i++) {
    const target = startRow + i;
    if (target >= rows.length) break;
    const line = overlay[i];
    const startCol = Math.max(0, Math.floor((width - line.length) / 2));
    const before = rows[target].slice(0, startCol);
    const after = rows[target].slice(startCol + line.length);
    rows[target] = (before + line + after).slice(0, width);
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
