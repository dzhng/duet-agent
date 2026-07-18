import { resolveModelName } from "../model-resolution/resolver.js";
import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type RoutingTable,
} from "../model-routing/table.js";
import { validateThinkingLevel } from "../session/thinking-level.js";
import { applyInlineSlashCommands, type SlashCommandContext } from "../tui/slash-commands.js";
import type { TurnRunnerConfig } from "../types/config.js";

/** Slash commands the non-TUI CLI applies inline. /clear, /paste, /clear-images, /diag
 *  have no meaning in a one-shot run so the CLI intentionally ignores them. */
const CLI_INLINE_COMMANDS: ReadonlySet<string> = new Set(["model", "thinking"]);

/** Logger surface. Production writes to stderr; tests pass a capturing function. */
export type InlineSlashLog = (line: string) => void;

/**
 * Apply inline `/model` and `/thinking` commands found in a one-shot CLI
 * prompt to the runner config in place, and return the prompt with the
 * slash forms stripped out. Callers dispatch the returned `residue`;
 * when it is empty (the whole prompt was just slash commands like
 * `duet "/model X"`), they skip the agent turn entirely — same way the
 * TUI's whole-message dispatcher returns early before reaching
 * `dispatchTurn`.
 *
 * Validation failures (unresolvable model name, unknown thinking level)
 * do not throw. They are surfaced through `log` as `[name] <error>\n`
 * lines matching the red error blocks the TUI handlers render. The
 * original config stays untouched so the prompt still dispatches on
 * whatever model / thinking level the boot-time flags chose.
 */
export function applyInlineSlashCommandsToCliConfig(
  prompt: string,
  config: TurnRunnerConfig,
  log: InlineSlashLog,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): { residue: string } {
  // /model and /thinking both need just appendBlock + their setter; the
  // other SlashCommandContext fields are optional precisely so this
  // shim does not have to fake them.
  const ctx: SlashCommandContext = {
    appendBlock: (label, body) => log(`${label ? `${label} ` : ""}${body}\n`),
    setModel: (model) => {
      // applyInlineSlashCommands's regex `(\S+)` guarantees the model
      // arg is non-empty non-whitespace, so we go straight to the
      // routing table check or concrete resolver, matching `--model` boot
      // validation without ever handing a virtual name to resolveModelName.
      const routed = isVirtualModel(model, routingTable);
      if (!routed && isVirtualModel(model, BUILT_IN_ROUTING_TABLE)) {
        throw new Error(`Unknown virtual model tier "${model}" in the active routing table.`);
      }
      if (!routed) resolveModelName(model);
      config.model = model;
      return { modelName: model, routed };
    },
    setThinkingLevel: (level) => {
      const normalized = validateThinkingLevel(level);
      if (config.model && isVirtualModel(config.model, routingTable)) {
        return { routedBy: config.model };
      }
      config.thinkingLevel = normalized;
      return { thinkingLevel: normalized };
    },
  };
  const { residue } = applyInlineSlashCommands(prompt, ctx, {
    onlyCommands: CLI_INLINE_COMMANDS,
  });
  return { residue };
}
