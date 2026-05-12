import { type CliRenderer, type TextRenderable } from "@opentui/core";
import { HINT_IDLE, HINT_RUNNING, HINT_SELECTION_COPY } from "./theme.js";
import { isTextBufferDestroyedError } from "./transcript-writer.js";
import type { TurnTerminalEvent } from "../types/protocol.js";

export interface StatusControllerOptions {
  /** Renderer that owns the chrome TextBuffers. Passed through so the
   *  controller can be constructed alongside the other chrome-touching
   *  controllers without re-deriving it from `status`/`hint`. */
  renderer: CliRenderer;
  /** Working-status line ("● working… (3s)"). Mutated by `setStatus` and the
   *  ticker; cleared when idle. */
  status: TextRenderable;
  /** Bottom hint row. Recomposed by `setHint` from the running/attachment/
   *  selection segments. */
  hint: TextRenderable;
  /**
   * Re-paints every in-flight tool block header with a fresh spinner +
   * elapsed counter. Invoked from the ticker so spinners advance in step
   * with the working-status line. Provided externally because the tool
   * block map lives with the step renderer, not the status controller.
   */
  refreshActiveToolBlocks: () => void;
}

/**
 * Owns the "is a turn running?" surface of the TUI: the working-status line,
 * the bottom hint row, and the 1 s ticker that advances both while a turn is
 * in flight. Also remembers the most recent terminal event so `runTui` can
 * return it to the caller after the renderer is destroyed.
 *
 * Preserves the v0.1.68 dual-mechanism guard against the OpenTUI race where
 * child TextBuffers are destroyed synchronously *before* the `destroy` event
 * fires: writes short-circuit on `destroyed`, and a `try/catch` around the
 * actual buffer mutation swallows the late-arriving exception and tears down
 * the ticker so the next callback does not throw again.
 */
export class StatusController {
  private destroyed = false;
  private running = false;
  private workingStartedAt: number | undefined;
  private workingTicker: ReturnType<typeof setInterval> | undefined;
  private workingMessage = "working…";
  private queuedFollowUps = 0;
  private pendingImageCount = 0;
  private lastSelectionText = "";
  private terminal: TurnTerminalEvent | undefined;

  constructor(private readonly opts: StatusControllerOptions) {}

  isRunning(): boolean {
    return this.running;
  }

  lastTerminal(): TurnTerminalEvent | undefined {
    return this.terminal;
  }

  /** Wall-clock start of the current turn, or undefined while idle. Read by
   *  the "● turn finished in Ns" and sleep banners which live outside this
   *  controller but want to show the same elapsed counter. */
  getWorkingStartedAt(): number | undefined {
    return this.workingStartedAt;
  }

  setWorkingMessage(message: string): void {
    this.workingMessage = message;
    this.refreshWorkingStatus();
  }

  setQueuedFollowUps(count: number): void {
    this.queuedFollowUps = count;
    this.refreshWorkingStatus();
  }

  /** Mirror of the most recent drag-selection text. Stored here so the hint
   *  row can advertise the copy keystroke only while something is selectable;
   *  the canonical selection state lives in `runTui`. */
  setSelectionText(text: string): void {
    this.lastSelectionText = text;
    this.refreshHint();
  }

  /** Mirror of `pendingImages.length`. Stored here so the hint row can show
   *  the attachment count without dragging the whole `PendingImage[]` into
   *  the controller. */
  setPendingImageCount(count: number): void {
    this.pendingImageCount = count;
    this.refreshHint();
  }

  markRunning(): void {
    this.running = true;
    this.workingMessage = "working…";
    this.workingStartedAt = Date.now();
    this.setHint(true);
    this.refreshWorkingStatus();
    this.startWorkingTicker();
  }

  /** Settle the working-status surface and optionally record the terminal
   *  event that ended the turn. The terminal is exposed via `lastTerminal()`
   *  so `runTui` can return it to its caller after renderer teardown. */
  markIdle(terminal?: TurnTerminalEvent): void {
    if (terminal !== undefined) this.terminal = terminal;
    this.running = false;
    this.stopWorkingTicker();
    this.workingStartedAt = undefined;
    this.workingMessage = "working…";
    this.setHint(false);
    this.refreshWorkingStatus();
  }

  setStatus(text: string): void {
    // Renderer teardown destroys the underlying TextBuffer synchronously, but
    // in-flight async work (session events, ticker callbacks, upgrade-status
    // pushes) may still drive chrome updates on the next microtask. The
    // `destroyed` flag catches writes after our destroy handler runs; the
    // try/catch backstops the window between OpenTUI tearing down child
    // TextBuffers and emitting the `destroy` event, which is when the ticker
    // callback typically lands.
    if (this.destroyed) return;
    try {
      this.opts.status.content = text;
    } catch (error) {
      if (isTextBufferDestroyedError(error)) {
        this.shutdown();
        return;
      }
      throw error;
    }
  }

  setHint(running: boolean): void {
    if (this.destroyed) return;
    const base = running ? HINT_RUNNING : HINT_IDLE;
    const segments: string[] = [];
    if (this.pendingImageCount > 0) segments.push(this.attachmentHint());
    segments.push(base);
    if (this.lastSelectionText.trim().length > 0) segments.push(HINT_SELECTION_COPY);
    try {
      this.opts.hint.content = segments.join(" · ");
    } catch (error) {
      if (isTextBufferDestroyedError(error)) {
        this.shutdown();
        return;
      }
      throw error;
    }
  }

  /** Repaint the hint row in the controller's current running state. Called
   *  from any input that changes one of the hint segments (attachments,
   *  selection) without flipping running. */
  refreshHint(): void {
    this.setHint(this.running);
  }

  refreshWorkingStatus(): void {
    if (this.destroyed) return;
    this.opts.refreshActiveToolBlocks();
    if (this.workingStartedAt === undefined) {
      this.setStatus(this.queuedFollowUps > 0 ? `queued follow-ups: ${this.queuedFollowUps}` : "");
      return;
    }
    const elapsed = formatElapsed(Date.now() - this.workingStartedAt);
    const queued = this.queuedFollowUps > 0 ? ` · queued follow-ups: ${this.queuedFollowUps}` : "";
    this.setStatus(`● ${this.workingMessage} (${elapsed})${queued}`);
  }

  /** Flip the destroyed flag and stop the ticker. Invoked from the renderer
   *  destroy handler and from our own try/catch when a buffer write fires the
   *  destroyed-buffer guard mid-flight. Subsequent chrome writes no-op. */
  shutdown(): void {
    this.destroyed = true;
    this.stopWorkingTicker();
  }

  private startWorkingTicker(): void {
    if (this.workingTicker !== undefined) return;
    this.workingTicker = setInterval(() => this.refreshWorkingStatus(), 1000);
  }

  private stopWorkingTicker(): void {
    if (this.workingTicker !== undefined) {
      clearInterval(this.workingTicker);
      this.workingTicker = undefined;
    }
  }

  private attachmentHint(): string {
    const n = this.pendingImageCount;
    return n === 1 ? "📎 1 image attached" : `📎 ${n} images attached`;
  }
}

/**
 * Renders an elapsed millisecond span as `${seconds}s` below a minute, and
 * `${minutes}m ${seconds}s` past it. Exported because the tool-call finalizer
 * and the post-turn banners share the same format.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Spinner marker for an in-flight tool call. Sub-second runs drop the
 * elapsed counter so a transcript of fast tools is not littered with "0s"
 * markers.
 */
export function runningMarker(elapsedMs: number): string {
  return elapsedMs >= 1000 ? `⏳ ${formatElapsed(elapsedMs)}` : "⏳";
}
