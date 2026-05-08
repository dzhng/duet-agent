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
import { COLORS } from "../tui/theme.js";
import type { Observation } from "../types/memory.js";
import type { MemoryDb } from "./memories-db.js";

const HINT = "↑/↓ navigate · e edit · d delete · q quit";

/**
 * Run the interactive memories browser.
 *
 * Renders observations in a scrollable list with metadata per row, lets the
 * user navigate with the arrow keys, edit the selected memory's content via
 * `$EDITOR` (or vi as a fallback), or delete it outright. All edits and
 * deletes hit `db` directly so the runner sees them on its next session.
 */
export async function runMemoriesTui(db: MemoryDb, dbPath: string): Promise<void> {
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
    content: `[duet memories] ${dbPath}`,
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

  let observations: Observation[] = await db.list();
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
      const meta = formatMeta(observation);
      row.content = t`${fg(headerColor)(`${marker} [${observation.priority}] ${observation.observedDate}`)} ${fg(metaColor)(meta)}\n  ${fg(metaColor)(observation.content)}`;
      row.fg = selected ? COLORS.agent : COLORS.hint;
    }
  }

  rebuildList();

  function moveSelection(direction: -1 | 1): void {
    if (observations.length === 0) return;
    selectedIndex = (selectedIndex + direction + observations.length) % observations.length;
    rebuildList();
  }

  async function reload(): Promise<void> {
    observations = await db.list();
    if (selectedIndex >= observations.length) {
      selectedIndex = Math.max(0, observations.length - 1);
    }
    rebuildList();
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
      moveSelection(-1);
      return;
    }
    if (key.name === "down") {
      key.preventDefault();
      moveSelection(1);
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

function formatMeta(observation: Observation): string {
  const parts: string[] = [observation.scope];
  if (observation.tags.length > 0) parts.push(`#${observation.tags.join(" #")}`);
  return parts.join(" · ");
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
