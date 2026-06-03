import {
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { COLORS } from "./theme.js";
import type { TranscriptEntry } from "./transcript-log.js";

/**
 * Hard cap on the number of renderables kept in the transcript ScrollBox.
 *
 * OpenTUI runs a full Yoga layout pass over every transcript child on each
 * frame, so an unbounded content tree makes per-frame layout O(n). Long
 * sessions append thousands of lines; once the tree grows tall enough, a
 * single frame (or a single streaming append, which re-lays out the whole
 * tree) costs hundreds of milliseconds to over a second, which starves the
 * event loop and makes mouse-wheel scrolling stop responding entirely — the
 * v0.1.171 long-transcript freeze. Capping the live node count keeps layout
 * cost constant regardless of session length.
 *
 * 1500 rows is a generous scrollback bound — dozens of screens — so eviction
 * is invisible in normal use while keeping a steady-state frame well under
 * the responsiveness budget.
 */
const MAX_TRANSCRIPT_RENDERABLES = 1500;

export interface TranscriptWriterOptions {
  /** Reads the last drag-selected text; surfaced in `/diag` key dumps so we
   *  can correlate "key fired" with "selection state at that moment". */
  getLastSelectionText: () => string;
  /** Invoked when the underlying TextBuffer is observed to be destroyed
   *  mid-mutation (the OpenTUI race the v0.1.68 fix targets). The caller
   *  uses this to tear down timers (working ticker) that would otherwise
   *  fire again on a dead buffer. */
  onBufferDestroyed?: () => void;
}

/**
 * Owns every write to the transcript ScrollBox plus the `/diag` key+selection
 * event log. Centralizing here keeps the post-teardown try/catch that swallows
 * "TextBuffer is destroyed" in exactly one place (v0.1.68 fix), and gives the
 * status/hint controllers a single `isDestroyed()` source of truth.
 */
export class TranscriptWriter {
  private destroyed = false;
  private hasRenderedAnyBlock = false;
  private keyDiagnostics = false;
  private readonly log: TranscriptEntry[] = [];
  // Rendered lines of the most recent `you:` block in the transcript.
  // Consulted by the sticky user-message banner watcher to decide whether
  // the block is still visible in the scroll viewport; the lines stay
  // valid until the next user block is appended (their layout y/height
  // are updated by Yoga as more content is added below them).
  private latestUserBlock: readonly TextRenderable[] = [];

  constructor(
    private readonly renderer: CliRenderer,
    private readonly transcript: ScrollBoxRenderable,
    private readonly options: TranscriptWriterOptions,
  ) {}

  // ---- transcript writes ---------------------------------------------------

  /** Append a single line. Empty content is ignored so callers can guard with
   *  raw input without producing blank rows; use `addLine` instead when a
   *  spacer is wanted and a renderable handle is needed. Returns the
   *  rendered renderable when one was created, so callers that need to
   *  later inspect layout (e.g. the sticky user-message banner) can keep a
   *  handle to it. */
  appendLine(content: string, fg: string): TextRenderable | undefined {
    if (!content) return undefined;
    if (this.destroyed) return undefined;
    try {
      const line = new TextRenderable(this.renderer, { content, fg });
      this.mount(line);
      return line;
    } catch (error) {
      if (isTextBufferDestroyedError(error)) {
        this.handleBufferDestroyed();
        return undefined;
      }
      throw error;
    }
  }

  /** Append a labelled block. `beginBlock()` inserts a blank separator before
   *  every block except the first so distinct steps stay visually distinct.
   *  Returns the rendered body lines (no leading spacer) so callers can
   *  track their layout position; empty lines are dropped by appendLine. */
  appendBlock(label: string | null, body: string, fg: string): TextRenderable[] {
    this.beginBlock();
    const text = label ? `${label}\n${body}` : body;
    const lines: TextRenderable[] = [];
    for (const part of text.split("\n")) {
      const line = this.appendLine(part, fg);
      if (line) lines.push(line);
    }
    return lines;
  }

  beginBlock(): void {
    if (this.hasRenderedAnyBlock) this.appendLine(" ", COLORS.hint);
    this.hasRenderedAnyBlock = true;
  }

  /** Append a line and return the renderable handle. Used by the starter
   *  block (which destroys its own refs on dismiss) and substitutes a single
   *  space for empty content so the renderable still occupies a row. */
  addLine(content: string, fg: string): TextRenderable {
    const line = new TextRenderable(this.renderer, { content: content || " ", fg });
    this.mount(line);
    return line;
  }

  /** Mount a renderable into the transcript ScrollBox and enforce the
   *  renderable cap. Every transcript write — this writer's own lines plus
   *  the step renderer's streaming / tool-call lines — funnels through here
   *  so the eviction policy lives in exactly one place. */
  mount(line: TextRenderable): void {
    this.transcript.add(line);
    this.evictOverflow();
  }

  /** Drop the oldest renderables once the tree grows past
   *  {@link MAX_TRANSCRIPT_RENDERABLES} so per-frame Yoga layout stays O(1)
   *  in session length (see the constant's doc for the freeze it prevents).
   *
   *  Eviction only runs while the view is pinned to the bottom. When the
   *  user has scrolled up to read history, removing lines from the top
   *  shifts the content under the viewport and yanks what they are reading;
   *  deferring until they return to the bottom keeps scrolled-up reading
   *  stable. The freeze this guards against happens during bottom-pinned
   *  streaming, so trimming there is both sufficient and invisible. */
  private evictOverflow(): void {
    if (!this.isPinnedToBottom()) return;
    const children = this.transcript.getChildren();
    const overflow = children.length - MAX_TRANSCRIPT_RENDERABLES;
    if (overflow <= 0) return;
    // Snapshot the victims before mutating the live children array.
    for (const victim of children.slice(0, overflow)) {
      this.transcript.remove(victim.id);
      victim.destroyRecursively();
    }
  }

  /** Whether the transcript is scrolled to (or pinned at) the bottom, using
   *  the same `scrollTop >= maxScrollTop` test OpenTUI applies internally for
   *  `stickyStart: "bottom"`. Reads last-rendered scroll geometry, which is
   *  exactly the "was the user at the bottom" signal eviction needs. */
  private isPinnedToBottom(): boolean {
    const maxScrollTop = Math.max(
      0,
      this.transcript.scrollHeight - this.transcript.viewport.height,
    );
    return this.transcript.scrollTop >= maxScrollTop;
  }

  // ---- transcript log ------------------------------------------------------

  /** Records a user/agent message body in the parallel log read by `/copy`
   *  and the copy keystroke. Trims and drops empty payloads so noisy
   *  presentation-only writes (spacers, etc.) do not pollute the log. */
  recordEntry(kind: TranscriptEntry["kind"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.log.push({ kind, text: trimmed });
  }

  entries(): readonly TranscriptEntry[] {
    return this.log;
  }

  /** Remember which rendered lines make up the most recent user block.
   *  Callers pass the array returned by {@link appendBlock} so the banner
   *  watcher can read live `y` / `height` values without re-traversing the
   *  transcript tree. */
  setLatestUserBlock(lines: readonly TextRenderable[]): void {
    this.latestUserBlock = lines;
  }

  getLatestUserBlock(): readonly TextRenderable[] {
    return this.latestUserBlock;
  }

  // ---- teardown ------------------------------------------------------------

  /** Flipped from the renderer `destroy` handler. Subsequent transcript
   *  writes short-circuit instead of throwing from a destroyed buffer. */
  markDestroyed(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  // ---- /diag key + selection logging ---------------------------------------

  setKeyDiagnosticsEnabled(enabled: boolean): void {
    this.keyDiagnostics = enabled;
  }

  isKeyDiagnosticsEnabled(): boolean {
    return this.keyDiagnostics;
  }

  logKey(label: string, key: KeyEvent): void {
    if (!this.keyDiagnostics) return;
    const flags: string[] = [];
    if (key.ctrl) flags.push("ctrl");
    if (key.shift) flags.push("shift");
    if (key.meta) flags.push("meta");
    if (key.super) flags.push("super");
    if (key.option) flags.push("option");
    const selection = this.options.getLastSelectionText();
    this.appendBlock(
      "[diag]",
      `${label} name=${JSON.stringify(key.name)} flags=[${flags.join(",")}] sequence=${JSON.stringify(key.sequence)} source=${key.source} | lastSelection=${selection.length}c rendererSel=${this.renderer.hasSelection ? "yes" : "no"}`,
      COLORS.hint,
    );
  }

  logSelection(text: string): void {
    if (!this.keyDiagnostics) return;
    this.appendBlock(
      "[diag]",
      `selection event: ${text.length} chars — ${JSON.stringify(text.slice(0, 80))}`,
      COLORS.hint,
    );
  }

  private handleBufferDestroyed(): void {
    this.destroyed = true;
    this.options.onBufferDestroyed?.();
  }
}

/**
 * OpenTUI's TextBuffer throws a plain Error with this exact message from its
 * `guard()` method when any setter is touched after destroy. We sniff the
 * message to distinguish post-teardown races (swallow) from real bugs
 * (rethrow). Exported so the status/hint controllers can share the same
 * sniff without re-importing OpenTUI internals.
 */
export function isTextBufferDestroyedError(error: unknown): boolean {
  return error instanceof Error && error.message === "TextBuffer is destroyed";
}
