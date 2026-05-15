import type { SkillAutocompleteItem } from "./autocomplete.js";
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
  /**
   * Invoked by `/reset` to ask the outer dispatcher to dispose the
   * current session and re-enter `runTui` with a fresh one. The TUI
   * tears its renderer down immediately after so the parent `while`
   * loop in `cli/run.ts` wakes and performs the swap.
   */
  onReset(): void;
}

/**
 * One built-in slash command. The same record drives both the dispatcher
 * (`matches` + `handle`) and the autocomplete picker (`name` +
 * `description`), so a command added here automatically shows up in `/`
 * suggestions without a second registration step.
 */
interface BuiltInSlashCommand {
  /** Bare command name, no leading slash. Picker renders this as `/name`. */
  name: string;
  /** One-line picker description, also used by `/help`-style surfaces. */
  description: string;
  /** True when this command should claim the submitted message. */
  matches(message: string): boolean;
  /** Side-effecting handler. Errors are surfaced through `appendBlock`. */
  handle(message: string, ctx: SlashCommandContext): void;
}

/** `/name` with no trailing arguments. */
function isBare(message: string, name: string): boolean {
  return message === `/${name}`;
}

/** `/name` or `/name <args>`. */
function isInvocation(message: string, name: string): boolean {
  return message === `/${name}` || message.startsWith(`/${name} `);
}

/**
 * Single source of truth for TUI-intercepted slash commands. Order here is
 * the order rows appear in the `/` picker. Skill-discovered commands are
 * appended after this list at boot time.
 */
export const BUILT_IN_SLASH_COMMANDS: readonly BuiltInSlashCommand[] = [
  {
    name: "image",
    description: "Attach a PNG/JPEG/GIF/WebP from disk by path: /image <path>",
    matches: (message) => isInvocation(message, "image"),
    handle: (message, ctx) => {
      void handleImageSlashCommand(message, ctx);
    },
  },
  {
    name: "paste",
    description: "Probe the OS clipboard for an image (fallback when Cmd+V is swallowed)",
    matches: (message) => isBare(message, "paste"),
    handle: (_, ctx) => {
      void ctx.pasteController.triggerClipboardProbe("slash");
    },
  },
  {
    name: "clear-images",
    description: "Drop pending image attachments before submit",
    matches: (message) => isBare(message, "clear-images"),
    handle: (_, ctx) => {
      ctx.pasteController.clearPendingImages();
      ctx.appendBlock("[paste]", "cleared pending image attachments", COLORS.system);
    },
  },
  {
    name: "copy",
    description: "Copy text to your clipboard: /copy [last|all|<N>] (default: last agent reply)",
    matches: (message) => isInvocation(message, "copy"),
    handle: (message, ctx) => {
      void ctx.copyController.handleCopySlashCommand(message);
    },
  },
  {
    name: "diag",
    description:
      "Toggle diagnostic logging (keys, selection events) for surfacing terminal-specific issues",
    matches: (message) => isInvocation(message, "diag"),
    handle: handleDiagSlashCommand,
  },
  {
    name: "feedback",
    description: "Send free-form feedback to the Duet team: /feedback <message>",
    matches: (message) => isInvocation(message, "feedback"),
    handle: (message, ctx) => {
      void handleFeedbackSlashCommand(message, ctx);
    },
  },
  {
    name: "reset",
    description: "Dispose the current session and start a fresh one",
    matches: (message) => isBare(message, "reset"),
    handle: (_, ctx) => {
      ctx.appendBlock("[reset]", "starting a new session…", COLORS.system);
      ctx.onReset();
    },
  },
];

/**
 * Picker rows derived from {@link BUILT_IN_SLASH_COMMANDS}. The dispatcher
 * and the autocomplete picker read from the same registry so a new command
 * cannot be wired into one surface without the other.
 */
export const BUILT_IN_SLASH_COMMAND_ITEMS: readonly SkillAutocompleteItem[] =
  BUILT_IN_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    group: "commands" as const,
  }));

/**
 * Routes the message to a local handler when it matches a built-in command.
 * Returns true when handled (caller must not forward the message to the
 * runner) and false when the message should fall through to the normal
 * prompt path.
 */
export function tryDispatchSlashCommand(message: string, ctx: SlashCommandContext): boolean {
  for (const command of BUILT_IN_SLASH_COMMANDS) {
    if (command.matches(message)) {
      command.handle(message, ctx);
      return true;
    }
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
