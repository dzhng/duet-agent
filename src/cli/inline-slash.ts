import { resolveModelName } from "../model-resolution/resolver.js";
import { validateThinkingLevel } from "../session/thinking-level.js";
import { applyInlineSlashCommands, type SlashCommandContext } from "../tui/slash-commands.js";
import type { TurnRunnerConfig } from "../types/config.js";

/** Slash commands the non-TUI CLI applies inline. /reset, /paste, /clear-images, /diag
 *  have no meaning in a one-shot run so the CLI intentionally ignores them. */
const CLI_INLINE_COMMANDS: ReadonlySet<string> = new Set(["model", "thinking"]);

/** Logger surface. Production writes to stderr; tests pass a capturing function. */
export type InlineSlashLog = (line: string) => void;

/**
 * Apply inline `/model` and `/thinking` commands found in a one-shot CLI
 * prompt to the runner config in place, and return the prompt with the
 * slash forms stripped out. Callers dispatch the returned `residue`;
 * when it is empty (the whole prompt was just slash commands like
 * `duet "/model X"`), they skip the agent turn entirely \u2014 same way the
 * TUI's whole-message dispatcher returns early before reaching
 * `dispatchTurn`.
 *
 * Validation failures (unresolvable model name, unknown thinking level,
 * empty argument) do not throw. They are surfaced through `log` as
 * `[name] <error message>\n` lines matching the red error blocks the TUI
 * handlers render. The original config stays untouched so the prompt
 * still dispatches on whatever model / thinking level the boot-time
 * flags chose.
 */
export function applyInlineSlashCommandsToCliConfig(
  prompt: string,
  config: TurnRunnerConfig,
  log: InlineSlashLog,
): { residue: string } {
  // Wire `applyInlineSlashCommands` against the CLI surface. The TUI
  // handlers want the full SlashCommandContext shape (with controllers
  // for /reset, /paste, etc.), but the CLI only enables model/thinking
  // \u2014 the other fields are guaranteed unreachable by the onlyCommands
  // filter, so this context only implements the slice the model/thinking
  // handlers actually use.
  const ctx: SlashCommandContext = {
    pasteController: undefined as never,
    copyController: undefined as never,
    transcriptWriter: undefined as never,
    onReset: () => {},
    appendBlock: (label, body) => log(`${label ? `${label} ` : ""}${body}\n`),
    setModel: (model) => {
      const trimmed = model.trim();
      if (!trimmed) throw new Error("Model name is required");
      resolveModelName(trimmed);
      config.model = trimmed;
      return { modelName: trimmed };
    },
    setThinkingLevel: (level) => {
      const normalized = validateThinkingLevel(level);
      config.thinkingLevel = normalized;
      return { thinkingLevel: normalized };
    },
  };
  const { residue } = applyInlineSlashCommands(prompt, ctx, {
    onlyCommands: CLI_INLINE_COMMANDS,
  });
  return { residue };
}
