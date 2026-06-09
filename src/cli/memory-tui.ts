import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
  createCliRenderer,
  fg,
  type KeyEvent,
  ScrollBoxRenderable,
  t,
  TextRenderable,
} from "@opentui/core";
import { PRIORITY_WEIGHT } from "../memory/loader.js";
import { DEFAULT_REFLECTION_BIAS } from "../memory/observational.js";
import { COLORS } from "../tui/theme.js";
import type { Observation } from "../types/memory.js";
import { MEMORY_PAGE_SIZE, type MemoryDb, scoreObservation } from "./memory-db.js";

const HINT = "↑/↓ navigate · e edit · d delete · q quit (more rows load as you scroll down)";

// Widest score a row can reach: highest priority weight × reflection bias at
// zero recency decay (0.5^0 = 1). Derived from the shared scoring constants so
// the score bar normalizes against the true ceiling and the fullest bar maps
// to the strongest possible memory rather than to whatever tops the page.
const MAX_SCORE = PRIORITY_WEIGHT.high * DEFAULT_REFLECTION_BIAS;
const SCORE_BAR_WIDTH = 10;

/**
 * Run the interactive memories browser.
 *
 * Renders observations in a scrollable list with metadata per row, lets the
 * user navigate with the arrow keys, edit the selected memory's content via
 * `$EDITOR` (or vi as a fallback), or delete it outright. All edits and
 * deletes hit `db` directly so the runner sees them on its next session.
 */
export async function runMemoryTui(db: MemoryDb, dbPath: string): Promise<void> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    targetFps: 60,
  });
  restoreWindowGlobal(previousWindow);

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const header = new TextRenderable(renderer, {
    content: `[duet memory] ${dbPath}`,
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });

  const list = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    scrollY: true,
    border: true,
    borderColor: COLORS.border,
    padding: 1,
  });

  const status = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.system,
    height: 1,
    flexShrink: 0,
  });
  const hint = new TextRenderable(renderer, {
    content: HINT,
    fg: COLORS.hint,
    height: 1,
    flexShrink: 0,
  });

  root.add(header);
  root.add(list);
  root.add(status);
  root.add(hint);
  renderer.root.add(root);

  // Fixed `now` for the whole session. Scores decay with wall-clock time, so
  // pinning it once keeps the ranking (and therefore LIMIT/OFFSET paging)
  // stable across page fetches and keeps every displayed score on the same
  // clock as the order they are sorted by.
  const renderNow = Date.now();
  // The list is lazily paginated: we hold only the rows fetched so far
  // (`observations`) plus the full table size (`totalCount`) so the footer can
  // show progress and `loadMore` knows when to stop. Rows arrive already
  // ranked by descending score from `db.listRanked`, so appending the next
  // page keeps the flat ordering intact.
  let observations: Observation[] = await db.listRanked({
    limit: MEMORY_PAGE_SIZE,
    offset: 0,
    now: renderNow,
  });
  let totalCount = await db.count();
  let selectedIndex = 0;
  // Memorize each row by id so re-renders only update the changed lines'
  // content/foreground rather than re-creating Renderables, which would
  // also reset scroll position and selection focus.
  const rowsById = new Map<string, TextRenderable>();
  let mountedIds: string[] = [];
  let busy = false;

  function setStatus(text: string, color: string = COLORS.system): void {
    status.content = text;
    status.fg = color;
  }

  function setCountStatus(): void {
    if (totalCount === 0) {
      setStatus("");
      return;
    }
    setStatus(`${observations.length} of ${totalCount} loaded · ranked by score`);
  }

  /** Whether more rows remain on disk beyond what is already loaded. */
  function hasMore(): boolean {
    return observations.length < totalCount;
  }

  /** Fetch and append the next page, preserving the ranked order. */
  async function loadMore(): Promise<void> {
    if (!hasMore()) return;
    const next = await db.listRanked({
      limit: MEMORY_PAGE_SIZE,
      offset: observations.length,
      now: renderNow,
    });
    if (next.length === 0) {
      // Defensive: total shrank under us (concurrent delete). Resync so
      // `hasMore` stops claiming there is more to fetch.
      totalCount = observations.length;
      return;
    }
    observations = [...observations, ...next];
  }

  function rebuildList(): void {
    if (observations.length === 0) {
      // Wipe the list and render a single placeholder row. Snapshot the
      // children first because list.remove mutates the underlying array.
      const existing = list.getChildren().slice();
      for (const child of existing) list.remove(child.id);
      rowsById.clear();
      mountedIds = [];
      const empty = new TextRenderable(renderer, {
        content: "(no observations yet — run a session first)",
        fg: COLORS.hint,
      });
      list.add(empty);
      return;
    }

    const desiredIds = observations.map((observation) => observation.id);
    if (mountedIds.join(",") !== desiredIds.join(",")) {
      // Order or membership changed; re-mount from scratch. We could try a
      // smaller diff, but the list is short and this keeps the code simple.
      const existing = list.getChildren().slice();
      for (const child of existing) list.remove(child.id);
      rowsById.clear();
      for (const observation of observations) {
        const row = new TextRenderable(renderer, {
          content: "",
          fg: COLORS.hint,
          wrapMode: "word",
        });
        rowsById.set(observation.id, row);
        list.add(row);
      }
      mountedIds = desiredIds;
    }

    for (const [index, observation] of observations.entries()) {
      const row = rowsById.get(observation.id);
      if (!row) continue;
      const selected = index === selectedIndex;
      const marker = selected ? "▶" : " ";
      const headerColor = selected ? COLORS.status : COLORS.user;
      const metaColor = selected ? COLORS.agent : COLORS.hint;
      const score = scoreObservation(observation, renderNow);
      const scoreCol = `${scoreBar(score)} ${score.toFixed(2)}`;
      const meta = formatMeta(observation, renderNow);
      row.content = t`${fg(headerColor)(`${marker} [${observation.priority}] ${observation.observedDate}`)}  ${fg(COLORS.tool)(scoreCol)}\n  ${fg(metaColor)(meta)}\n  ${fg(metaColor)(observation.content)}`;
      row.fg = selected ? COLORS.agent : COLORS.hint;
    }

    // Keep the selected row centered in the viewport. Row heights vary with
    // wrapped content, so we read the row's laid-out `y` and `height` on the
    // next frame, then clamp to the scrollable range. Without the frame
    // delay, freshly-mounted rows still report y=0.
    const selected = observations[selectedIndex];
    const row = selected ? rowsById.get(selected.id) : undefined;
    if (!row) return;
    setTimeout(() => {
      const viewportH = list.viewport.height;
      const target = row.y + row.height / 2 - viewportH / 2;
      const max = Math.max(0, list.scrollHeight - viewportH);
      list.scrollTop = Math.max(0, Math.min(max, target));
    }, 0);
  }

  rebuildList();
  setCountStatus();

  /**
   * Move the cursor by one row. Navigating down off the end of the loaded set
   * lazily fetches the next page and steps onto it (infinite scroll); only
   * once everything is loaded does down wrap back to the top. Up wraps to the
   * bottom of whatever is currently loaded.
   */
  async function moveSelection(direction: -1 | 1): Promise<void> {
    if (observations.length === 0) return;
    if (direction === 1 && selectedIndex === observations.length - 1) {
      if (hasMore()) {
        await loadMore();
        selectedIndex = Math.min(selectedIndex + 1, observations.length - 1);
        rebuildList();
        setCountStatus();
        return;
      }
      selectedIndex = 0;
      rebuildList();
      return;
    }
    if (direction === -1 && selectedIndex === 0) {
      selectedIndex = observations.length - 1;
      rebuildList();
      return;
    }
    selectedIndex += direction;
    rebuildList();
  }

  /**
   * Re-fetch the rows currently in view after an edit or delete. Keeps the
   * same number of rows loaded (clamped to the new total) so the paged view
   * stays consistent and the cursor never points past the end.
   */
  async function reload(): Promise<void> {
    totalCount = await db.count();
    const loaded = Math.max(MEMORY_PAGE_SIZE, observations.length);
    observations = await db.listRanked({ limit: loaded, offset: 0, now: renderNow });
    if (selectedIndex >= observations.length) {
      selectedIndex = Math.max(0, observations.length - 1);
    }
    rebuildList();
    setCountStatus();
  }

  async function deleteSelected(): Promise<void> {
    if (busy) return;
    const observation = observations[selectedIndex];
    if (!observation) return;
    busy = true;
    setStatus(`deleting ${observation.id}…`);
    try {
      await db.delete(observation.id);
      await reload();
      setStatus(`deleted ${observation.id}`, COLORS.status);
    } catch (error) {
      setStatus(formatError("delete failed", error), COLORS.error);
    } finally {
      busy = false;
    }
  }

  async function editSelected(): Promise<void> {
    if (busy) return;
    const observation = observations[selectedIndex];
    if (!observation) return;
    busy = true;
    setStatus(`editing ${observation.id}…`);
    try {
      const next = await editInExternalEditor(observation.content, renderer);
      if (next === undefined) {
        setStatus("edit cancelled", COLORS.hint);
        return;
      }
      const trimmed = next.replace(/\s+$/, "");
      if (trimmed === observation.content) {
        setStatus("edit unchanged", COLORS.hint);
        return;
      }
      await db.updateContent(observation.id, trimmed);
      await reload();
      setStatus(`updated ${observation.id}`, COLORS.status);
    } catch (error) {
      setStatus(formatError("edit failed", error), COLORS.error);
    } finally {
      busy = false;
    }
  }

  const keyHandler = (renderer as unknown as { _keyHandler: InternalKeyHandlerLike })._keyHandler;
  keyHandler.onInternal("keypress", (key: KeyEvent) => {
    if (busy) return;
    if (key.name === "q" || key.name === "escape") {
      key.preventDefault();
      renderer.destroy();
      return;
    }
    if (key.name === "up") {
      key.preventDefault();
      void moveSelection(-1);
      return;
    }
    if (key.name === "down") {
      key.preventDefault();
      void moveSelection(1);
      return;
    }
    if (key.name === "d") {
      key.preventDefault();
      void deleteSelected();
      return;
    }
    if (key.name === "e") {
      key.preventDefault();
      void editSelected();
      return;
    }
  });

  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve());
  });
}

interface InternalKeyHandlerLike {
  onInternal(event: "keypress", handler: (key: KeyEvent) => void): void;
}

interface RendererLifecycle {
  pause?(): void;
  resume?(): void;
  start?(): void;
  stop?(): void;
}

/**
 * Suspend the OpenTUI renderer, drop the user into `$EDITOR` (or vi) on a
 * scratch file seeded with `initial`, then resume the renderer.
 *
 * Returns the new contents on save, or `undefined` if the editor exited
 * non-zero (caller treats this as "cancelled").
 */
async function editInExternalEditor(
  initial: string,
  renderer: { pause?: () => void; resume?: () => void } & object,
): Promise<string | undefined> {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "duet-memory-"));
  const file = join(dir, "memory.txt");
  writeFileSync(file, initial.endsWith("\n") ? initial : `${initial}\n`);
  // OpenTUI doesn't expose a stable pause/resume API across versions; call
  // whichever lifecycle methods exist before/after handing the terminal off.
  const lifecycle = renderer as RendererLifecycle;
  lifecycle.pause?.();
  lifecycle.stop?.();
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (exitCode !== 0) return undefined;
    return readFileSync(file, "utf8");
  } finally {
    lifecycle.start?.();
    lifecycle.resume?.();
  }
}

function formatMeta(observation: Observation, now: number): string {
  const parts: string[] = [observation.kind];
  if (observation.tags.length > 0) parts.push(`#${observation.tags.join(" #")}`);
  parts.push(`used ${relativeTime(observation.lastUsedAt, now)}`);
  parts.push(`created ${relativeTime(observation.createdAt, now)}`);
  return parts.join(" · ");
}

/**
 * Fixed-width unicode bar visualizing `score` against {@link MAX_SCORE}, the
 * strongest score any row can reach. Filled blocks scale with the score so a
 * glance separates dominant memories from decayed ones.
 */
function scoreBar(score: number, max: number = MAX_SCORE, width: number = SCORE_BAR_WIDTH): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
  const filled = Math.round(ratio * width);
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}`;
}

/** Compact relative age like `just now`, `5m ago`, `3h ago`, `12d ago`. */
function relativeTime(timestamp: number, now: number): string {
  const deltaMs = now - timestamp;
  if (deltaMs < 0) return "in the future";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function formatError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function restoreWindowGlobal(previousWindow: PropertyDescriptor | undefined): void {
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
    return;
  }
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
}
