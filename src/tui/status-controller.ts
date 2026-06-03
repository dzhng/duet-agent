import { type CliRenderer, type TextRenderable } from "@opentui/core";
import {
  COLORS,
  HINT_EXIT_CONFIRM,
  HINT_IDLE,
  HINT_RUNNING,
  HINT_SELECTION_COPY,
} from "./theme.js";
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
  /** True while the bare-Ctrl+C exit confirmation is showing. Set by
   *  `showExitConfirm`, cleared by `clearExitConfirm`. While active the
   *  status line is pinned to the confirm prompt and other refreshes are
   *  suppressed so an unrelated chrome write cannot wipe it. */
  private exitConfirmActive = false;
  /** Subscribers notified on every running→idle / idle→running transition.
   *  Used by the dino panel to drive its freeze (idle) / resume (running)
   *  lifecycle without coupling the panel to the session event stream. */
  private readonly runningListeners = new Set<(running: boolean) => void>();
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

  /** Whether the bare-Ctrl+C exit confirmation prompt is currently shown. */
  isExitConfirmActive(): boolean {
    return this.exitConfirmActive;
  }

  /** Pin the persistent "press Ctrl+C again or Enter to exit" prompt to the
   *  status line. Only reached from an idle, empty composer, so the status
   *  line is otherwise blank and free to host it. Painted amber so it reads
   *  as a prompt rather than the green working-status line. */
  showExitConfirm(): void {
    if (this.destroyed) return;
    this.exitConfirmActive = true;
    this.opts.status.fg = COLORS.system;
    this.setStatus(HINT_EXIT_CONFIRM);
  }

  /** Tear the exit prompt down and restore the normal status/hint surface.
   *  Idempotent so callers can fire it on any cancelling keystroke without
   *  first checking whether the prompt was up. */
  clearExitConfirm(): void {
    if (!this.exitConfirmActive) return;
    this.exitConfirmActive = false;
    if (!this.destroyed) this.opts.status.fg = COLORS.status;
    this.refreshWorkingStatus();
    this.refreshHint();
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
    const wasRunning = this.running;
    this.running = true;
    this.workingMessage = "working…";
    this.workingStartedAt = Date.now();
    this.refreshHint();
    this.refreshWorkingStatus();
    this.startWorkingTicker();
    if (!wasRunning) this.notifyRunningChange(true);
  }

  /** Settle the working-status surface and optionally record the terminal
   *  event that ended the turn. The terminal is exposed via `lastTerminal()`
   *  so `runTui` can return it to its caller after renderer teardown. */
  markIdle(terminal?: TurnTerminalEvent): void {
    if (terminal !== undefined) this.terminal = terminal;
    const wasRunning = this.running;
    this.running = false;
    this.stopWorkingTicker();
    this.workingStartedAt = undefined;
    this.workingMessage = "working…";
    this.refreshHint();
    this.refreshWorkingStatus();
    if (wasRunning) this.notifyRunningChange(false);
  }

  /** Subscribe to running-state transitions. The listener is invoked with
   *  the new running value on every flip; idempotent calls (markIdle while
   *  already idle) are suppressed. Returns an unsubscribe handle. */
  onRunningChange(listener: (running: boolean) => void): () => void {
    this.runningListeners.add(listener);
    return () => this.runningListeners.delete(listener);
  }

  private notifyRunningChange(running: boolean): void {
    for (const listener of this.runningListeners) {
      try {
        listener(running);
      } catch {
        // Listener errors must not break the status surface; they bubble
        // to the renderer's unhandled rejection path instead.
      }
    }
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

  /** Recompose the bottom hint row from the controller's current running
   *  state plus any active attachment / selection segments. Called from any
   *  input that changes a hint segment (attachments, selection) and from
   *  the running-state transitions in `markRunning` / `markIdle`. */
  refreshHint(): void {
    if (this.destroyed || this.exitConfirmActive) return;
    const base = this.running ? HINT_RUNNING : HINT_IDLE;
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

  refreshWorkingStatus(): void {
    if (this.destroyed) return;
    // The exit-confirm prompt owns the status line while it is up; do not
    // let a ticker tick or a queued-follow-up update paint over it.
    if (this.exitConfirmActive) return;
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
