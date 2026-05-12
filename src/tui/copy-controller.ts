import { type CliRenderer, type KeyEvent } from "@opentui/core";

import { type ClipboardWriteResult, writeClipboardText } from "./clipboard.js";
import type { StatusController } from "./status-controller.js";
import { COLORS } from "./theme.js";
import { parseCopyArgument, selectCopyText } from "./transcript-log.js";
import type { TranscriptWriter } from "./transcript-writer.js";

export interface CopyControllerOptions {
  /** Renderer that exposes the OSC 52 fallback writer and the
   *  drag-selection clear hook invoked after a successful copy. */
  renderer: CliRenderer;
  /** Transcript writer used to surface copy outcomes (success summary,
   *  clipboard write failure) and to source `/copy last|all|<N>` payloads
   *  from the message log. */
  transcriptWriter: TranscriptWriter;
  /** Status surface owns the selection-aware hint segment; cleared after a
   *  successful keystroke/slash-command copy so the hint drops the
   *  copy-keystroke advertisement. */
  statusController: Pick<StatusController, "setSelectionText">;
  /** Reads the most recent drag-selected text. The selection listener still
   *  lives in `runTui` so transcript-writer diagnostics see it on the same
   *  tick; the controller pulls it through this getter at copy time. */
  getLastSelectionText: () => string;
  /** Clears the cached drag-selection after a successful keystroke copy so
   *  subsequent keystrokes do not re-copy stale text. */
  clearLastSelectionText: () => void;
}

/**
 * Owns every path that moves text onto the OS clipboard: the platform copy
 * keystroke (Cmd+C / Cmd+Shift+C / Ctrl+Shift+C), the `/copy` slash command,
 * and the underlying two-stage writer (CLI first, OSC 52 fallback).
 *
 * Two-stage clipboard write rationale: the platform-native CLI (pbcopy /
 * wl-copy / xclip / xsel / clip.exe) goes first because `writeClipboardText`
 * reads the clipboard back to confirm the bytes landed — exit-code-only
 * success is not enough (pbcopy from inside a raw-mode TUI on Warp/macOS
 * exits 0 without updating NSPasteboard). OSC 52 is only the fallback when
 * no local CLI exists (SSH session with no clipboard tool installed
 * remotely); when a CLI ran but failed verification we surface that error
 * directly instead of falling through to OSC 52, because OSC 52 would also
 * silently "succeed" on the same broken terminals and hide the real failure.
 */
export class CopyController {
  constructor(private readonly opts: CopyControllerOptions) {}

  /**
   * Detect the platform copy keystroke and, when a non-empty drag-selection
   * exists, route to `copyActiveSelection`. Returns true when the keystroke
   * was consumed (caller must not fall through to Esc/other handlers) and
   * false otherwise so the caller can keep processing.
   *
   * Accepts both "c" and "C" as the key name because some kitty parsers
   * report the shifted letter while others report the base letter with
   * `shift: true`.
   */
  handleCopyKeystroke(key: KeyEvent): boolean {
    const isCopyLetter = key.name === "c" || key.name === "C";
    if (!isCopyLetter) return false;
    const cmdHeld = key.super || key.meta;
    const isCmdC = cmdHeld && !key.shift && !key.ctrl;
    const isCmdShiftC = cmdHeld && key.shift && !key.ctrl;
    const isCtrlShiftC = key.ctrl && key.shift && !cmdHeld;
    if (!(isCmdC || isCmdShiftC || isCtrlShiftC)) return false;
    if (this.opts.getLastSelectionText().trim().length === 0) return false;
    key.preventDefault();
    void this.copyActiveSelection();
    return true;
  }

  /**
   * Copy the active drag-selection to the clipboard and clear the highlight
   * so the user gets visual confirmation the action happened. Used by the
   * platform copy keystroke; the slash command path goes through
   * `handleCopySlashCommand` so it can also serve `/copy last|all|<N>`.
   */
  async copyActiveSelection(): Promise<void> {
    const text = this.opts.getLastSelectionText();
    if (text.trim().length === 0) return;
    const result = await this.copyTextToClipboard(text);
    this.opts.renderer.clearSelection();
    this.opts.clearLastSelectionText();
    this.opts.statusController.setSelectionText("");
    if (result.ok) {
      this.opts.transcriptWriter.appendBlock(
        "[copy]",
        `copied selection (${text.length} char${text.length === 1 ? "" : "s"}) to clipboard via ${result.via}`,
        COLORS.system,
      );
    } else {
      this.opts.transcriptWriter.appendBlock(
        "[copy]",
        `clipboard write failed: ${result.error ?? "unknown error"}` +
          (process.platform === "linux" ? "\nInstall one of: wl-clipboard, xclip, xsel" : ""),
        COLORS.error,
      );
    }
  }

  /**
   * Resolve a `/copy ...` invocation to clipboard text and pipe it to the
   * OS clipboard. When the user has an active drag-selection and ran a bare
   * `/copy`, copy that highlight verbatim — it matches what they actually
   * have on screen. Otherwise fall back to the transcript-log heuristic
   * (`last` / `all` / `<N>`).
   *
   * Failures are surfaced in the transcript so users on minimal Linux
   * installs see exactly which writer is missing.
   */
  async handleCopySlashCommand(raw: string): Promise<void> {
    const argumentRaw = raw === "/copy" ? "" : raw.slice("/copy ".length);
    const argument = parseCopyArgument(argumentRaw);
    if (argument === undefined) {
      this.opts.transcriptWriter.appendBlock(
        "[copy]",
        "Usage: /copy [last|all|<N>]  — last (default) copies the most recent agent reply, " +
          "or copies the active drag-selection when one is present",
        COLORS.system,
      );
      return;
    }

    // A bare `/copy` (or the copy keystroke while a selection is active)
    // prefers the drag-selection so the clipboard matches what the user
    // has highlighted on screen; an explicit `/copy last|all|<N>` always
    // uses the transcript log instead.
    const explicitArgument = argumentRaw.trim().length > 0;
    const selection = this.opts.getLastSelectionText();
    const useSelection = !explicitArgument && selection.trim().length > 0;
    const text = useSelection
      ? selection
      : selectCopyText(this.opts.transcriptWriter.entries(), argument);
    if (!text) {
      this.opts.transcriptWriter.appendBlock("[copy]", "nothing to copy yet", COLORS.system);
      return;
    }
    const result = await this.copyTextToClipboard(text);
    if (result.ok) {
      const summary = useSelection
        ? `selection (${text.length} char${text.length === 1 ? "" : "s"})`
        : this.describeCopySelection(argument, text.length);
      this.opts.transcriptWriter.appendBlock(
        "[copy]",
        `copied ${summary} to clipboard via ${result.via}`,
        COLORS.system,
      );
    } else {
      this.opts.transcriptWriter.appendBlock(
        "[copy]",
        `clipboard write failed: ${result.error ?? "unknown error"}` +
          (process.platform === "linux" ? "\nInstall one of: wl-clipboard, xclip, xsel" : ""),
        COLORS.error,
      );
    }
  }

  async copyTextToClipboard(text: string): Promise<ClipboardWriteResult> {
    const cli = await writeClipboardText(text);
    if (cli.ok) return cli;
    // Only fall back to OSC 52 when the CLI was simply unavailable. If a
    // CLI ran but the readback did not match (cli.kind ===
    // "verification-failed"), OSC 52 is on the same broken pipe and would
    // silently "succeed" the same way — surface the real error.
    if (
      cli.kind === "no-writer" &&
      this.opts.renderer.isOsc52Supported() &&
      this.opts.renderer.copyToClipboardOSC52(text)
    ) {
      return { ok: true, via: "OSC 52" };
    }
    return cli;
  }

  describeCopySelection(argument: "last" | "all" | number, length: number): string {
    const chars = `${length} char${length === 1 ? "" : "s"}`;
    if (argument === "last") return `last message (${chars})`;
    if (argument === "all") return `full transcript (${chars})`;
    return `last ${argument} messages (${chars})`;
  }
}
