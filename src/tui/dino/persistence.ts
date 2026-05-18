// Reads/writes the dino panel's tiny persisted footprint under
// `~/.duet/dino/`. Only the high score is persisted: panel open/closed
// state is intentionally session-local because the spec is that every
// new busy cycle starts at "hint only" and the user toggles back in.
// Writes are best-effort: a failed write degrades the next run to the
// in-memory default but never propagates to the caller, because losing a
// high score is strictly better than crashing the TUI on a read-only
// home directory.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DINO_DIR = join(homedir(), ".duet", "dino");
const HIGHSCORE_FILE = join(DINO_DIR, "highscore");

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

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
