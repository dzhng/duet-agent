import type { Skill } from "@earendil-works/pi-coding-agent";
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
  /**
   * Invoked by `/model <name>` to swap the model used for subsequent
   * turns. Returns the canonicalized name the session will use on the
   * next prompt, or throws if validation fails (unknown shorthand /
   * missing provider credentials). The change is queued: the current
   * in-flight turn keeps the model it started with.
   */
  setModel(model: string): { modelName: string };
  /**
   * Invoked by `/thinking <level>` to swap the thinking level used for
   * subsequent turns. Returns the normalized level, or throws if the
   * value is not one of minimal / low / medium / high / xhigh. The
   * change is queued: the current in-flight turn keeps the level it
   * started with.
   */
  setThinkingLevel(level: string): { thinkingLevel: string };
}

/**
 * Shape of inline matching for a command — i.e. the form the command
 * takes when it appears anywhere in a longer prompt rather than as the
 * whole submitted message.
 *
 * - `"none"`: bare invocation only (`/reset`). Matches `/name` with
 *   whitespace / start / end boundaries on both sides.
 * - `"token"`: requires one whitespace-bounded argument (`/model X`).
 *   Matches `/name <token>` with whitespace / start before and consumes
 *   the next non-whitespace run as the argument.
 *
 * Commands that take rest-of-line arguments (`/feedback`, `/copy`,
 * `/image`) intentionally have no inline shape — there is no
 * unambiguous way to split "the argument" from "the rest of the
 * prompt" mid-message, so they remain whole-message only.
 */
type InlineShape = "none" | "token";

/**
 * One built-in slash command. The same record drives the whole-message
 * dispatcher (`matches` + `handle`), the inline extractor (`inline`),
 * and the autocomplete picker (`name` + `description`), so a command
 * added here automatically shows up in `/` suggestions without a
 * second registration step.
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
  /**
   * When set, the command also runs when it appears anywhere inside a
   * longer prompt. The inline extractor reconstructs a synthetic
   * whole-message form (`/name` or `/name <arg>`) and calls `handle`
   * with it, so the inline path reuses the same logic the whole-message
   * path already uses.
   */
  inline?: InlineShape;
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
    inline: "none",
  },
  {
    name: "clear-images",
    description: "Drop pending image attachments before submit",
    matches: (message) => isBare(message, "clear-images"),
    handle: (_, ctx) => {
      ctx.pasteController.clearPendingImages();
      ctx.appendBlock("[paste]", "cleared pending image attachments", COLORS.system);
    },
    inline: "none",
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
    inline: "none",
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
    inline: "none",
  },
  {
    name: "model",
    description:
      "Switch the model for the next turn (does not affect the current turn): /model <name>",
    matches: (message) => isInvocation(message, "model"),
    handle: handleModelSlashCommand,
    inline: "token",
  },
  {
    name: "thinking",
    description:
      "Switch the thinking level for the next turn (minimal|low|medium|high|xhigh): /thinking <level>",
    matches: (message) => isInvocation(message, "thinking"),
    handle: handleThinkingSlashCommand,
    inline: "token",
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
 * Build the slash-picker catalog from a list of discovered skills. Built-in
 * commands lead, discovered skills follow under the `skills` group. Shared
 * between the initial boot seed and the per-open background reload so both
 * surfaces stay in lockstep.
 */
export function buildSkillAutocompleteCatalog(
  skills: readonly Skill[],
): readonly SkillAutocompleteItem[] {
  return [
    ...BUILT_IN_SLASH_COMMAND_ITEMS,
    ...skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      group: "skills" as const,
    })),
  ];
}

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

/** Escape a literal command name for safe inclusion in a RegExp pattern. */
function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One inline-eligible slash command match found inside a longer prompt,
 * with its argument (if the command has a `token` inline shape). The
 * scanner emits these in the order BUILT_IN_SLASH_COMMANDS declares
 * them, not the order they appear in the message; callers that care
 * about textual order can sort by `match.index` themselves.
 */
export interface InlineSlashMatch {
  /** Bare command name, no leading slash. */
  name: string;
  /** Argument text for `token`-shape commands; empty for `none`-shape. */
  arg: string;
}

/**
 * Scan a prompt for every inline-eligible slash command appearing inside
 * it, without firing any side effects. Used by both the TUI inline
 * runner and the non-TUI CLI — the TUI then routes each match back
 * through the regular `handle()` path (so users see the same `[model]`
 * confirmation block), while the CLI applies the side effect against
 * its own config object without faking a TUI context.
 */
export function* scanInlineSlashCommands(
  message: string,
  options: { onlyCommands?: ReadonlySet<string> } = {},
): Generator<InlineSlashMatch> {
  for (const command of BUILT_IN_SLASH_COMMANDS) {
    if (!command.inline) continue;
    if (options.onlyCommands && !options.onlyCommands.has(command.name)) continue;
    const namePattern = escapeRegex(command.name);
    // Boundary `(?:^|\s)` keeps `/model` from matching mid-word (e.g.
    // inside a URL `https://example.com/model`). For the token shape
    // the captured argument bounds the right edge so neighboring text
    // is not consumed; the bare shape uses a `\s|$` lookahead for the
    // same reason. We iterate matches with `matchAll` rather than
    // `replace` because the message is not rewritten — the original
    // text is passed through to the agent verbatim, the same way
    // `/skill-name` references survive the prompt dispatch.
    const pattern =
      command.inline === "token"
        ? new RegExp(`(?:^|\\s)\\/${namePattern}[ \\t]+(\\S+)`, "g")
        : new RegExp(`(?:^|\\s)\\/${namePattern}(?=\\s|$)`, "g");
    for (const match of message.matchAll(pattern)) {
      const arg = command.inline === "token" ? (match[1] ?? "") : "";
      yield { name: command.name, arg };
    }
  }
}

/**
 * Run every inline-eligible slash command appearing inside a longer
 * prompt, leaving the original message text untouched. Mirrors how the
 * autocomplete picker handles `/skill-name` references: the slash form
 * stays in the prompt the agent sees, and the local side effect (config
 * mutation for `/model` / `/thinking`, controller calls for the rest)
 * fires before the prompt dispatches.
 *
 * Returns the names of every command that fired so callers can log,
 * meter, or branch on the side effects; the message is the caller's to
 * dispatch (or not).
 */
export function runInlineSlashCommands(
  message: string,
  ctx: SlashCommandContext,
  options: { onlyCommands?: ReadonlySet<string> } = {},
): { handledCommands: string[] } {
  const handledCommands: string[] = [];
  const byName = new Map(BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command]));
  for (const { name, arg } of scanInlineSlashCommands(message, options)) {
    const command = byName.get(name);
    if (!command) continue;
    const synthetic = arg ? `/${name} ${arg}` : `/${name}`;
    command.handle(synthetic, ctx);
    handledCommands.push(name);
  }
  return { handledCommands };
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

/**
 * `/thinking <level>` validates the requested level against the pi-ai
 * `ThinkingLevel` set, then mutates session config so the next prompt
 * picks it up. Like `/model`, the swap is queued for the next turn and
 * does not interrupt the in-flight one.
 */
function handleThinkingSlashCommand(raw: string, ctx: SlashCommandContext): void {
  const argument = raw === "/thinking" ? "" : raw.slice("/thinking ".length).trim();
  if (!argument) {
    ctx.appendBlock(
      "[thinking]",
      "Usage: /thinking <level>  — one of minimal, low, medium, high, xhigh",
      COLORS.system,
    );
    return;
  }
  try {
    const { thinkingLevel } = ctx.setThinkingLevel(argument);
    ctx.appendBlock(
      "[thinking]",
      `next turn will think at ${thinkingLevel}. The current turn (if any) keeps its level.`,
      COLORS.system,
    );
  } catch (error) {
    ctx.appendBlock(
      "[thinking]",
      error instanceof Error ? error.message : String(error),
      COLORS.error,
    );
  }
}

/**
 * `/model <name>` validates the requested model against the same resolver
 * the CLI uses at boot, then mutates session config so the next prompt
 * picks it up. The handler intentionally does not interrupt or restart
 * an in-flight turn; the swap applies starting at the next user turn.
 */
function handleModelSlashCommand(raw: string, ctx: SlashCommandContext): void {
  const argument = raw === "/model" ? "" : raw.slice("/model ".length).trim();
  if (!argument) {
    ctx.appendBlock(
      "[model]",
      "Usage: /model <name>  — switch the model for the next turn (e.g. /model sonnet-4.6)",
      COLORS.system,
    );
    return;
  }
  try {
    const { modelName } = ctx.setModel(argument);
    ctx.appendBlock(
      "[model]",
      `next turn will use ${modelName}. The current turn (if any) keeps its model.`,
      COLORS.system,
    );
  } catch (error) {
    ctx.appendBlock(
      "[model]",
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
