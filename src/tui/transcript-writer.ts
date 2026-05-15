import {
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { COLORS } from "./theme.js";
import type { TranscriptEntry } from "./transcript-log.js";

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
      this.transcript.add(line);
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
    this.transcript.add(line);
    return line;
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
