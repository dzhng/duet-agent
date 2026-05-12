import type { CopyController } from "./copy-controller.js";
import type { PasteController } from "./paste-controller.js";
import type { TranscriptWriter } from "./transcript-writer.js";
import { submitDuetFeedback } from "../lib/feedback.js";
import { COLORS } from "./theme.js";

/**
 * Surface used by the slash-command dispatcher. Every handler in this module
 * is stateless and reaches its mutable state through the controllers wired up
 * by `runTui`. The dispatcher returns true when the message was claimed so
 * `submit()` can short-circuit before the message reaches `session.prompt()`.
 */
export interface SlashCommandContext {
  pasteController: PasteController;
  copyController: CopyController;
  transcriptWriter: TranscriptWriter;
  appendBlock(label: string | null, body: string, fg: string): void;
}

/**
 * Routes the message to a local handler when it begins with a slash command
 * recognized by the TUI. Returns true when handled (caller must not forward
 * the message to the runner) and false when the message should fall through
 * to the normal prompt path.
 */
export function tryDispatchSlashCommand(message: string, ctx: SlashCommandContext): boolean {
  if (message.startsWith("/image ") || message === "/image") {
    void handleImageSlashCommand(message, ctx);
    return true;
  }
  if (message === "/paste") {
    void ctx.pasteController.triggerClipboardProbe("slash");
    return true;
  }
  if (message === "/clear-images") {
    ctx.pasteController.clearPendingImages();
    ctx.appendBlock("[paste]", "cleared pending image attachments", COLORS.system);
    return true;
  }
  if (message === "/copy" || message.startsWith("/copy ")) {
    void ctx.copyController.handleCopySlashCommand(message);
    return true;
  }
  if (message === "/diag" || message.startsWith("/diag ")) {
    handleDiagSlashCommand(message, ctx);
    return true;
  }
  if (message === "/feedback" || message.startsWith("/feedback ")) {
    void handleFeedbackSlashCommand(message, ctx);
    return true;
  }
  return false;
}

/**
 * `/diag` toggles a key + selection event log so users can show us exactly
 * what their terminal forwards when something silently fails (a keystroke
 * that never reaches the handler, a selection event firing with empty text).
 * Kept as a flag rather than a one-shot capture so we can layer additional
 * diagnostic facets on the same surface without inventing new commands.
 */
function handleDiagSlashCommand(raw: string, ctx: SlashCommandContext): void {
  const argument = raw === "/diag" ? "" : raw.slice("/diag ".length).trim();
  if (argument === "" || argument === "keys") {
    const enabled = !ctx.transcriptWriter.isKeyDiagnosticsEnabled();
    ctx.transcriptWriter.setKeyDiagnosticsEnabled(enabled);
    ctx.appendBlock(
      "[diag]",
      enabled
        ? "key + selection event logging ON. Run /diag again to stop."
        : "key + selection event logging OFF.",
      COLORS.system,
    );
    return;
  }
  ctx.appendBlock(
    "[diag]",
    "Usage: /diag (or /diag keys) — toggles key + selection event logging",
    COLORS.system,
  );
}

async function handleFeedbackSlashCommand(raw: string, ctx: SlashCommandContext): Promise<void> {
  const content = raw.slice("/feedback".length).trim();
  if (!content) {
    ctx.appendBlock(
      "[feedback]",
      "Usage: /feedback <message>  — send free-form feedback to the Duet team",
      COLORS.system,
    );
    return;
  }
  ctx.appendBlock("[feedback]", "sending…", COLORS.system);
  try {
    const { baseUrl } = await submitDuetFeedback({ content });
    ctx.appendBlock("[feedback]", `Thanks! Feedback sent to ${baseUrl}.`, COLORS.system);
  } catch (error) {
    ctx.appendBlock(
      "[feedback]",
      error instanceof Error ? error.message : String(error),
      COLORS.error,
    );
  }
}

async function handleImageSlashCommand(raw: string, ctx: SlashCommandContext): Promise<void> {
  const rest = raw.slice("/image".length).trim();
  if (!rest) {
    ctx.appendBlock(
      "[paste]",
      "Usage: /image <path>  — attach a PNG/JPEG/GIF/WebP from disk",
      COLORS.system,
    );
    return;
  }
  await ctx.pasteController.attachImageFromPath(rest);
}
