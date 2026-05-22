import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_SLASH_COMMAND_ITEMS,
  type SlashCommandContext,
  tryDispatchSlashCommand,
} from "../src/tui/slash-commands.js";

/**
 * Focused coverage for `/compact`. Validates the dispatcher routes the bare
 * invocation, the handler forwards a parameterless call into the context,
 * and the transcript line lands. The full keyboard path is exercised by
 * the broader TUI integration suites; this file keeps the per-command
 * branch coverage cheap and close to the registry.
 */
function makeContext(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext & { blocks: Array<{ label: string | null; body: string; fg: string }> } {
  const blocks: Array<{ label: string | null; body: string; fg: string }> = [];
  return {
    appendBlock: (label, body, fg) => {
      blocks.push({ label, body, fg });
    },
    setModel: (model) => ({ modelName: model }),
    setThinkingLevel: (level) => ({ thinkingLevel: level }),
    ...overrides,
    blocks,
  };
}

describe("/compact slash command", () => {
  test("/compact is registered in the autocomplete catalog", () => {
    const item = BUILT_IN_SLASH_COMMAND_ITEMS.find((row) => row.name === "compact");
    expect(item).toBeDefined();
    expect(item?.group).toBe("commands");
  });

  test("/compact dispatches the context callback and writes a [compact] block", () => {
    let calls = 0;
    const ctx = makeContext({
      compact: () => {
        calls += 1;
      },
    });

    const handled = tryDispatchSlashCommand("/compact", ctx);

    expect(handled).toBe(true);
    expect(calls).toBe(1);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.label).toBe("[compact]");
    // The user-visible line names the 20% target and the "next request"
    // framing so the slash command's promise lines up with what the
    // runner actually does — shrink the outgoing prompt, not the
    // durable transcript.
    expect(ctx.blocks[0]!.body).toContain("20%");
    expect(ctx.blocks[0]!.body).toContain("next request");
  });

  test("/compact reports unavailability when no compact callback is wired", () => {
    // The CLI inline slash path constructs a SlashCommandContext without
    // a compact callback (compact is TUI-only there). The handler must
    // gracefully report instead of throwing on undefined.
    const ctx = makeContext({});
    const handled = tryDispatchSlashCommand("/compact", ctx);
    expect(handled).toBe(true);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.body).toContain("not available");
  });
});
