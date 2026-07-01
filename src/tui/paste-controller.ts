import { decodePasteBytes, type PasteEvent, type TextareaRenderable } from "@opentui/core";

import {
  describeMacClipboardTypes,
  extractImagePathCandidates,
  loadImageFromPath,
  looksLikeImageFilePath,
  type PendingImage,
  persistPastedImage,
  resolveExistingImagePath,
  sniffImageMimeType,
  tryReadClipboardImage,
  tryReadClipboardText,
} from "./paste.js";
import type { StatusController } from "./status-controller.js";
import { COLORS } from "./theme.js";
import type { TurnPromptImage } from "../types/protocol.js";

export interface PasteControllerOptions {
  /** Composer textarea. The controller inserts `[Image #N]` placeholders
   *  into its buffer and falls back to text inserts when a clipboard probe
   *  yields plain text after a keystroke ate a paste event. */
  inputField: TextareaRenderable;
  /** Session id used to namespace the on-disk paste cache under
   *  `~/.duet/cache/paste/<sessionId>/`. */
  sessionId: string;
  /** Working directory for resolving relative paths handed to `/image`. */
  workDir: string;
  /** Append a bordered transcript block (label + body) for paste diagnostics
   *  and per-attachment confirmation lines. */
  appendBlock: (label: string | null, body: string, color: string) => void;
  /** Status surface that owns the bottom-hint attachment counter. The
   *  controller calls `setPendingImageCount` whenever the queue changes so
   *  the hint stays in sync. */
  statusController: Pick<StatusController, "setPendingImageCount">;
}

/**
 * Owns the pending-image queue surfaced into the prompt as `[Image #N]`
 * placeholders. Handles three intake paths that converge on the same
 * `persistPastedImage` / `loadImageFromPath` machinery:
 *
 *   1. Bracketed-paste events that carry binary image bytes (kitty, ghostty,
 *      recent iTerm2).
 *   2. Text-shaped pastes that resolve to a single existing image file path
 *      (Finder/Files drag-paste, file:// URLs).
 *   3. Manual probes triggered by Cmd+V/Ctrl+V or the `/paste` slash command
 *      against terminals that strip binary clipboards.
 *
 * The queue resets after every submit (callers drive that via `consume()`),
 * so users see a fresh `#1` label per turn.
 */
export class PasteController {
  private readonly inputField: TextareaRenderable;
  private readonly sessionId: string;
  private readonly workDir: string;
  private readonly appendBlock: (label: string | null, body: string, color: string) => void;
  private readonly statusController: Pick<StatusController, "setPendingImageCount">;

  private pendingImages: PendingImage[] = [];
  /** Monotonic id used to label the next attachment. Reset together with
   *  `pendingImages` so labels restart at `#1` after each submit. */
  private nextImageId = 1;

  constructor(options: PasteControllerOptions) {
    this.inputField = options.inputField;
    this.sessionId = options.sessionId;
    this.workDir = options.workDir;
    this.appendBlock = options.appendBlock;
    this.statusController = options.statusController;
  }

  /** Read-only view of the currently queued attachments. Useful for callers
   *  that need to render attachment footnotes alongside the user message. */
  attachments(): readonly PendingImage[] {
    return this.pendingImages;
  }

  /**
   * Drain the queue, returning the attachments that were pending at submit
   * time. The caller forwards `.attachment` payloads to the runner; the
   * controller resets so the next turn starts at `[Image #1]`.
   */
  consume(): PendingImage[] {
    const drained = this.pendingImages;
    this.pendingImages = [];
    this.nextImageId = 1;
    this.statusController.setPendingImageCount(0);
    return drained;
  }

  /** Drop all queued attachments. No-op when the queue is already empty so
   *  `/clear-images` does not redundantly repaint the hint. */
  clearPendingImages(): void {
    if (this.pendingImages.length === 0) return;
    this.pendingImages = [];
    this.nextImageId = 1;
    this.statusController.setPendingImageCount(0);
  }

  /** Re-stage already-built image attachments from a queued follow-up. */
  stageImages(images: readonly TurnPromptImage[]): void {
    if (images.length === 0) return;
    for (const attachment of images) {
      this.pendingImages.push({
        id: this.nextImageId,
        label: `[Image #${this.nextImageId}]`,
        path: "",
        attachment,
      });
      this.nextImageId += 1;
    }
    this.statusController.setPendingImageCount(this.pendingImages.length);
  }

  /**
   * Handle a bracketed-paste event from the textarea. Decides synchronously
   * whether the payload is image bytes, a file path, an empty trigger that
   * warrants a clipboard probe, or plain text that should fall through to
   * the textarea's default insert path.
   */
  async handlePasteEvent(event: PasteEvent): Promise<void> {
    const metadata = event.metadata;
    const sniffed = sniffImageMimeType(event.bytes);
    const inferredMime =
      metadata?.mimeType && metadata.mimeType.startsWith("image/") ? metadata.mimeType : sniffed;

    // Synchronous fast paths — the paste payload itself is enough to decide.
    if (inferredMime) {
      event.preventDefault();
      await this.attachPastedImageBytes(event.bytes, inferredMime);
      return;
    }

    if (metadata?.kind === "binary") {
      // Non-image binary paste — we cannot meaningfully forward it, but the
      // terminal already swallowed the keystroke, so suppress the default
      // text-insert path that would otherwise garble the prompt.
      event.preventDefault();
      this.appendBlock(
        "[paste]",
        "Unsupported binary clipboard contents (only PNG/JPEG/GIF/WebP).",
        COLORS.system,
      );
      return;
    }

    // Text-shaped paste. Three sub-cases, ordered cheapest first so common
    // text pastes never wait on the macOS Swift clipboard probe:
    //
    //   1. The text resolves to an image file path (Finder/Files drag-paste).
    //   2. The terminal forwarded an empty payload but the OS clipboard
    //      may carry an image promise (e.g. Figma "Copy as PNG", screenshot,
    //      browser image copy that bracketed-paste cannot represent).
    //   3. Plain text — just insert it.
    //
    // Sub-cases 1 and 3 are fully synchronous after the path heuristic, so
    // the buffer paints immediately. Only sub-case 2 spawns the Swift
    // probe, and only when there is literally no text to insert anyway.
    const originalText = decodePasteBytes(event.bytes);
    const candidate = looksLikeImageFilePath(originalText);

    if (candidate) {
      // Path-shaped paste: suppress the default insert so we can swap in
      // the [Image #N] placeholder once load resolves.
      event.preventDefault();
      try {
        const pending = await loadImageFromPath({
          cwd: this.workDir,
          rawPath: candidate,
          id: this.nextImageId,
        });
        this.nextImageId += 1;
        this.pendingImages.push(pending);
        this.inputField.insertText(pending.label);
        this.appendBlock(
          "[paste]",
          `attached ${pending.label} from ${pending.path}`,
          COLORS.system,
        );
        this.statusController.setPendingImageCount(this.pendingImages.length);
      } catch (error) {
        // The clipboard looked like an image path but we could not load
        // it — surface why and restore the original text so the user can
        // edit it manually instead of losing what they pasted.
        this.appendBlock(
          "[paste]",
          `looked like an image path but could not attach ${candidate}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          COLORS.system,
        );
        if (originalText.length > 0) this.inputField.insertText(originalText);
      }
      return;
    }

    if (originalText.length === 0) {
      // No text payload — the terminal had nothing to forward but the OS
      // clipboard may still carry an image promise. Suppress the default
      // (which would do nothing anyway) and run the slow probe.
      event.preventDefault();
      const clipboardImage = await tryReadClipboardImage();
      if (clipboardImage) {
        await this.attachPastedImageBytes(clipboardImage.bytes, clipboardImage.mimeType);
      }
      return;
    }

    // Plain text paste — fall through to the InputRenderable's default
    // insert path, which paints synchronously. Users whose intended image
    // arrived as text-shaped bytes (e.g. Figma) can still trigger an
    // explicit clipboard probe via the `/paste` slash command.
  }

  /**
   * Manual clipboard probe. Read the OS clipboard for an image right now and
   * attach it if found; otherwise fall back to a text probe so a Cmd+V/Ctrl+V
   * keystroke that ate a legitimate text paste does not silently swallow it.
   * The `source` distinguishes the keystroke entry point from the `/paste`
   * slash command so we only emit the "no readable image" diagnostic for
   * explicit user intent.
   */
  async triggerClipboardProbe(source: "keystroke" | "slash"): Promise<void> {
    try {
      const clipboardImage = await tryReadClipboardImage();
      if (clipboardImage) {
        await this.attachPastedImageBytes(clipboardImage.bytes, clipboardImage.mimeType);
        return;
      }
      // No image on the clipboard. The keystroke path may have eaten a
      // legitimate text paste, so fall back to a text probe so users do not
      // lose what they were trying to paste.
      const text = await tryReadClipboardText();
      if (text) {
        this.inputField.insertText(text);
        return;
      }
      if (source === "slash") {
        // Surface the actual clipboard UTI list when a /paste probe comes
        // up empty — lets users see what their source app actually put
        // there so the failure stops being mysterious.
        const types = await describeMacClipboardTypes();
        const detail = types
          ? ` — clipboard types: ${types}`
          : " — (could not query clipboard types; clipboard may be empty)";
        this.appendBlock(
          "[paste]",
          `clipboard had no readable image or text${detail}`,
          COLORS.system,
        );
      }
    } catch (error) {
      this.appendBlock(
        "[paste]",
        `clipboard probe failed: ${error instanceof Error ? error.message : String(error)}`,
        COLORS.error,
      );
    }
  }

  /**
   * Scan a free-form message (the compose buffer at submit time) for
   * image-shaped paths and silently attach any that resolve to a real file.
   *
   * This is the fallback for terminals that do not fire a bracketed-paste
   * event when a file is dragged in — the textarea sees the path as typed
   * characters, so `handlePasteEvent` never runs. By scanning on submit we
   * still capture the bytes before ephemeral files (notably macOS
   * `NSIRD_screencaptureui_*` screenshot tempfiles) disappear.
   *
   * Unlike the paste path, this method does not rewrite the message: callers
   * already have the path text in their outgoing prompt, and replacing it
   * after the user pressed Enter would feel like surgery on the message.
   * Duplicate paths (already in the pending queue) are skipped. Paths that
   * do not point at a file on disk are silently skipped so prose references
   * to nonexistent paths do not produce noise; only files that exist but
   * fail to load (unsupported format, too large, empty) surface a `[paste]`
   * diagnostic.
   */
  async autoAttachFromMessage(message: string): Promise<void> {
    const candidates = extractImagePathCandidates(message);
    if (candidates.length === 0) return;
    const alreadyAttached = new Set(this.pendingImages.map((p) => p.path));
    // Re-staged follow-up images keep their bytes but not their source path,
    // so path-only dedup misses popped prompts that still mention that path.
    const alreadyAttachedContent = new Set(
      this.pendingImages.map((p) => imageContentKey(p.attachment)),
    );
    const seen = new Set<string>();
    for (const candidate of candidates) {
      // Normalize each extracted substring through the same shell-escape /
      // file:// / quote handling the paste path uses, so `file://` URLs and
      // `\ `-escaped drag paths resolve the same way here.
      const normalized = looksLikeImageFilePath(candidate);
      if (!normalized) continue;
      // Silent miss: if nothing is on disk at that location, skip without
      // emitting a `[paste]` diagnostic. Users often reference file paths in
      // prose that have nothing to do with attachment intent; a missing file
      // is not meaningful feedback for them. Errors are still surfaced below
      // for files that exist but fail to load (unsupported format, too
      // large, empty) — those are real attachment failures worth reporting.
      const resolvedPath = resolveExistingImagePath(this.workDir, normalized);
      if (!resolvedPath) continue;
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);
      if (alreadyAttached.has(resolvedPath)) continue;
      try {
        const pending = await loadImageFromPath({
          cwd: this.workDir,
          rawPath: normalized,
          id: this.nextImageId,
        });
        const contentKey = imageContentKey(pending.attachment);
        if (alreadyAttachedContent.has(contentKey)) continue;
        alreadyAttachedContent.add(contentKey);
        alreadyAttached.add(pending.path);
        this.nextImageId += 1;
        this.pendingImages.push(pending);
        this.appendBlock(
          "[paste]",
          `auto-attached ${pending.label} from ${pending.path}`,
          COLORS.system,
        );
        this.statusController.setPendingImageCount(this.pendingImages.length);
      } catch (error) {
        this.appendBlock(
          "[paste]",
          `found ${resolvedPath} but could not attach it: ${
            error instanceof Error ? error.message : String(error)
          }`,
          COLORS.error,
        );
      }
    }
  }

  /**
   * Attach an image from disk by path. Drives the `/image <path>` slash
   * command. Inserts the `[Image #N]` placeholder back into the (likely now
   * empty) input so the user can keep typing their prompt with the image
   * already attached.
   */
  async attachImageFromPath(rawPath: string): Promise<void> {
    try {
      const pending = await loadImageFromPath({
        cwd: this.workDir,
        rawPath,
        id: this.nextImageId,
      });
      this.nextImageId += 1;
      this.pendingImages.push(pending);
      this.inputField.insertText(pending.label);
      this.appendBlock("[paste]", `attached ${pending.label} from ${pending.path}`, COLORS.system);
      this.statusController.setPendingImageCount(this.pendingImages.length);
    } catch (error) {
      this.appendBlock(
        "[paste]",
        error instanceof Error ? error.message : String(error),
        COLORS.error,
      );
    }
  }

  /**
   * Persist raw image bytes (from a bracketed-paste event or clipboard probe)
   * under the session cache and surface the resulting `[Image #N]`
   * placeholder in the prompt buffer.
   */
  private async attachPastedImageBytes(bytes: Uint8Array, mimeType: string): Promise<void> {
    try {
      const pending = await persistPastedImage({
        sessionId: this.sessionId,
        id: this.nextImageId,
        bytes,
        mimeType,
      });
      this.nextImageId += 1;
      this.pendingImages.push(pending);
      this.inputField.insertText(pending.label);
      this.appendBlock(
        "[paste]",
        `attached ${pending.label} (${mimeType}, ${formatBytes(bytes.length)})`,
        COLORS.system,
      );
      this.statusController.setPendingImageCount(this.pendingImages.length);
    } catch (error) {
      this.appendBlock(
        "[paste]",
        error instanceof Error ? error.message : String(error),
        COLORS.error,
      );
    }
  }
}

function imageContentKey(attachment: TurnPromptImage): string {
  return `${attachment.mimeType}:${attachment.data}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
