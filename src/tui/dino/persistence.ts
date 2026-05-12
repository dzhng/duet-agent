// Reads/writes the dino panel's tiny persisted footprint under
// `~/.duet/dino/`. Two files:
//   highscore  → one ASCII integer
//   panel      → "open" | "closed"
// Both writes are best-effort: a failed write degrades the next run to the
// in-memory default but never propagates to the caller, because losing a
// high score is strictly better than crashing the TUI on a read-only home
// directory.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DINO_DIR = join(homedir(), ".duet", "dino");
const HIGHSCORE_FILE = join(DINO_DIR, "highscore");
const PANEL_STATE_FILE = join(DINO_DIR, "panel");

export type PanelOpenState = "open" | "closed";

export function loadHighScore(): number {
  try {
    const raw = readFileSync(HIGHSCORE_FILE, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveHighScore(score: number): void {
  try {
    ensureDir(HIGHSCORE_FILE);
    writeFileSync(HIGHSCORE_FILE, `${Math.max(0, Math.floor(score))}\n`, "utf8");
  } catch {
    // Best-effort.
  }
}

export function loadPanelState(): PanelOpenState {
  try {
    const raw = readFileSync(PANEL_STATE_FILE, "utf8").trim();
    return raw === "open" ? "open" : "closed";
  } catch {
    return "closed";
  }
}

export function savePanelState(state: PanelOpenState): void {
  try {
    ensureDir(PANEL_STATE_FILE);
    writeFileSync(PANEL_STATE_FILE, `${state}\n`, "utf8");
  } catch {
    // Best-effort.
  }
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
