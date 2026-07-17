import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillAutocompleteItem } from "./autocomplete.js";
import type { CopyController } from "./copy-controller.js";
import type { PasteController } from "./paste-controller.js";
import type { TranscriptWriter } from "./transcript-writer.js";
import type { RouterStatus } from "../model-routing/router.js";
import { submitDuetFeedback } from "../lib/feedback.js";
import { COLORS } from "./theme.js";

/**
 * Surface used by the slash-command dispatcher. Every handler in this module
 * is stateless and reaches its mutable state through the controllers wired up
 * by `runTui`. The dispatcher returns true when the message was claimed so
 * `submit()` can short-circuit before the message reaches `session.prompt()`.
 */
export interface SlashCommandContext {
  /**
   * Controllers are optional because not every consumer of this
   * interface wires the full TUI. The non-TUI CLI applies inline
   * `/model` and `/thinking` against a stripped-down context that
   * has no clipboard, transcript, or session-management surface — those commands
   * are filtered out via `applyInlineSlashCommands`'s `onlyCommands`
   * before they could ever run, so the handlers that depend on these
   * controllers never see a missing one in practice.
   */
  pasteController?: PasteController;
  copyController?: CopyController;
  transcriptWriter?: TranscriptWriter;
  appendBlock(label: string | null, body: string, fg: string): void;
  /**
   * Invoked by `/clear` to ask the outer dispatcher to dispose the
   * current session and re-enter `runTui` with a fresh one. The TUI
   * tears its renderer down immediately after so the parent `while`
   * loop in `cli/run.ts` wakes and performs the swap.
   */
  onClear?(): void;
  /**
   * Invoked by `/model <name>` to swap the model used for subsequent
   * turns. The result distinguishes routed tiers from concrete pins so
   * confirmation text can describe the actual behavior. The current in-flight
   * turn keeps the model it started with.
   */
  setModel(model: string): { modelName: string; routed?: boolean };
  /**
   * Invoked by `/thinking <level>` to swap the thinking level used for
   * subsequent turns. Routed sessions return `routedBy` and do not mutate
   * effort because the route owns it; concrete sessions return the normalized
   * level. Unknown levels throw in either mode.
   */
  setThinkingLevel(level: string): { thinkingLevel?: string; routedBy?: string };
  /** Router-owned snapshot used by the read-only `/route` inspector. */
  routeStatus?(): RouterStatus | undefined;
  /**
   * Invoked by `/compact` to ask the runner to compact its in-memory
   * `TurnState`. The runner targets 20% of the effective context window;
   * the slash command itself takes no arguments. Implementations forward
   * the request through the session/RPC layer so the same command works
   * in the TUI and over the protocol.
   */
  compact?(): void;
}

/**
 * Shape of inline matching for a command — i.e. the form the command
 * takes when it appears anywhere in a longer prompt rather than as the
 * whole submitted message.
 *
 * - `"none"`: bare invocation only (`/clear`). Matches `/name` with
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
      void ctx.pasteController?.triggerClipboardProbe("slash");
    },
    inline: "none",
  },
  {
    name: "clear-images",
    description: "Drop pending image attachments before submit",
    matches: (message) => isBare(message, "clear-images"),
    handle: (_, ctx) => {
      ctx.pasteController?.clearPendingImages();
      ctx.appendBlock("[paste]", "cleared pending image attachments", COLORS.system);
    },
    inline: "none",
  },
  {
    name: "copy",
    description: "Copy text to your clipboard: /copy [last|all|<N>] (default: last agent reply)",
    matches: (message) => isInvocation(message, "copy"),
    handle: (message, ctx) => {
      void ctx.copyController?.handleCopySlashCommand(message);
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
    name: "clear",
    description: "Dispose the current session and start a fresh one",
    matches: (message) => isBare(message, "clear"),
    handle: (_, ctx) => {
      ctx.appendBlock("[clear]", "starting a new session…", COLORS.system);
      ctx.onClear?.();
    },
    inline: "none",
  },
  {
    name: "model",
    description: "Route via frontier|balanced|economy, or pin a concrete model: /model <name>",
    matches: (message) => isInvocation(message, "model"),
    handle: handleModelSlashCommand,
    inline: "token",
  },
  {
    name: "route",
    description: "Inspect the active virtual-model route, cadence, advisor, and pin state",
    matches: (message) => isBare(message, "route"),
    handle: handleRouteSlashCommand,
  },
  {
    name: "thinking",
    description:
      "Switch the thinking level for the next turn (minimal|low|medium|high|xhigh): /thinking <level>",
    matches: (message) => isInvocation(message, "thinking"),
    handle: handleThinkingSlashCommand,
    inline: "token",
  },
  {
    name: "compact",
    description:
      "Shrink the next request to ~20% of the context window by advancing the wire-shaping horizon (durable transcript is preserved)",
    matches: (message) => isBare(message, "compact"),
    handle: handleCompactSlashCommand,
    inline: "none",
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
 * Build the global RegExp that matches one inline slash command.
 * Boundary `(^|\s)` keeps `/model` from matching mid-word (e.g. inside
 * a URL `https://example.com/model`) and is captured so the strip step
 * can put the boundary character back — otherwise adjacent words would
 * fuse. For the token shape, group 2 captures the argument and bounds
 * the right edge; the bare shape uses a `\s|$` lookahead for the same
 * reason.
 */
function inlinePattern(name: string, shape: InlineShape): RegExp {
  const namePattern = escapeRegex(name);
  // Capture group 1 = boundary character (empty at start-of-string, else
  // the one whitespace char before the slash). The replace callback
  // returns it as-is so adjacent words do not fuse after stripping.
  // Token shape additionally captures the next non-whitespace run as
  // the argument; bare shape uses a lookahead for the right edge so
  // neighboring text is not consumed.
  return shape === "token"
    ? new RegExp(`(^|\\s)\\/${namePattern}[ \\t]+(\\S+)`, "g")
    : new RegExp(`(^|\\s)\\/${namePattern}(?=\\s|$)`, "g");
}

/**
 * Result of `applyInlineSlashCommands`: which commands fired, plus the
 * leftover prompt after stripping every matched slash form. The residue
 * is what the caller should dispatch to the agent; if `.trim()` on it
 * is empty, the whole prompt was just slash commands and no agent turn
 * needs to run.
 */
export interface InlineSlashResult {
  /** Commands whose handler fired, in BUILT_IN_SLASH_COMMANDS order. */
  handledCommands: string[];
  /** Prompt with matched slash forms removed and whitespace collapsed. */
  residue: string;
}

/**
 * Apply every inline-eligible slash command found inside a longer
 * prompt: fire its handler (so users see the same `[model]` confirmation
 * block they would for a whole-message `/model`), and strip the slash
 * form out of the message so the agent does not have to re-parse local
 * UI commands as user content. The returned `residue` is the message
 * the caller should actually dispatch — callers check `.trim() === ""`
 * to detect the "whole prompt was just slash commands" case and skip
 * the agent turn entirely.
 *
 * Boundary characters are preserved on the inside of the strip so that
 * adjacent words do not fuse: `"hey /model X please"` becomes
 * `"hey  please"` mid-strip and then collapses to `"hey please"` at the
 * end. Multi-line prompts keep their newlines.
 */
export function applyInlineSlashCommands(
  message: string,
  ctx: SlashCommandContext,
  options: { onlyCommands?: ReadonlySet<string> } = {},
): InlineSlashResult {
  const handledCommands: string[] = [];
  let residue = message;
  for (const command of BUILT_IN_SLASH_COMMANDS) {
    if (!command.inline) continue;
    if (options.onlyCommands && !options.onlyCommands.has(command.name)) continue;
    residue = residue.replace(
      inlinePattern(command.name, command.inline),
      (_match, lead: string, arg?: string) => {
        const synthetic =
          command.inline === "token" && arg ? `/${command.name} ${arg}` : `/${command.name}`;
        command.handle(synthetic, ctx);
        handledCommands.push(command.name);
        // Preserve the boundary character (space, tab, newline, or empty
        // for start-of-string) so words on either side of the stripped
        // command stay separated.
        return lead;
      },
    );
  }
  if (handledCommands.length > 0) {
    // Collapse the holes left by stripped commands. Only flatten runs
    // of spaces/tabs so multi-line prompts keep their newlines, and
    // trim the outer edges to avoid leading/trailing whitespace from a
    // command that sat at the very start or end of the message.
    residue = residue
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim();
  }
  return { handledCommands, residue };
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
    // `transcriptWriter` is only optional for the non-TUI CLI shim,
    // which filters /diag out before it can run — in the TUI (the only
    // surface that exposes /diag) it is always wired.
    if (!ctx.transcriptWriter) return;
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
    const { thinkingLevel, routedBy } = ctx.setThinkingLevel(argument);
    ctx.appendBlock(
      "[thinking]",
      routedBy
        ? `route effort owns thinking while routing via ${routedBy}; no thinking override was changed.`
        : `next turn will think at ${thinkingLevel}. The current turn (if any) keeps its level.`,
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
 * `/model <name>` accepts routing tiers and concrete pins through the session
 * selection seam. The handler does not interrupt an in-flight turn.
 */
function handleModelSlashCommand(raw: string, ctx: SlashCommandContext): void {
  const argument = raw === "/model" ? "" : raw.slice("/model ".length).trim();
  if (!argument) {
    ctx.appendBlock(
      "[model]",
      "Usage: /model <name>  — route via frontier|balanced|economy, or pin a concrete model",
      COLORS.system,
    );
    return;
  }
  try {
    const { modelName, routed } = ctx.setModel(argument);
    ctx.appendBlock(
      "[model]",
      routed
        ? `next turn routes via ${modelName}. The current turn (if any) keeps its model.`
        : `next turn is pinned to ${modelName}. The current turn (if any) keeps its model.`,
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

/** Render the router's detached status snapshot without deriving policy in the TUI. */
function handleRouteSlashCommand(_raw: string, ctx: SlashCommandContext): void {
  const status = ctx.routeStatus?.();
  if (!status) {
    ctx.appendBlock("[route]", "This session is not using virtual-model routing.", COLORS.system);
    return;
  }

  const current =
    status.route && status.modelName && status.thinkingLevel
      ? `${status.route} → ${status.modelName} (${status.thinkingLevel})`
      : "awaiting initial target";
  const rationale = status.lastRationale ?? "awaiting first classification";
  const cadence =
    status.stepsUntilClassification === 0
      ? "due now"
      : `${status.stepsUntilClassification} ${pluralizeSteps(status.stepsUntilClassification)} until next check`;
  const advisorCooldown = status.advisorGate.allowed
    ? "ready"
    : `${status.advisorGate.stepsUntilAllowed} ${pluralizeSteps(status.advisorGate.stepsUntilAllowed)} until available`;
  const pinned = status.pinned ? "yes — routing suspended by concrete model pin" : "no";

  ctx.appendBlock(
    "[route]",
    [
      `tier: ${status.tier}`,
      `current: ${current}`,
      `rationale: ${rationale}`,
      `cadence: ${cadence}`,
      `advisor: ${status.advisorEnabled ? "enabled" : "disabled"} · ${advisorCooldown}`,
      `pinned: ${pinned}`,
    ].join("\n"),
    COLORS.system,
  );
}

function pluralizeSteps(count: number): "step" | "steps" {
  return count === 1 ? "step" : "steps";
}

/**
 * `/compact` asks the runner to compact its in-memory `TurnState` down to
 * 20% of the parent agent's effective context window. Same handler is
 * reachable over RPC via the protocol-level `compact` command, so the
 * slash form and the RPC form share semantics. No arguments — the target
 * is fixed by the runner.
 */
function handleCompactSlashCommand(_raw: string, ctx: SlashCommandContext): void {
  if (!ctx.compact) {
    ctx.appendBlock("[compact]", "compact is not available in this context", COLORS.system);
    return;
  }
  ctx.compact();
  ctx.appendBlock(
    "[compact]",
    "shrinking the next request to ~20% of the context window…",
    COLORS.system,
  );
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
  await ctx.pasteController?.attachImageFromPath(rest);
}
