import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_SLASH_COMMAND_ITEMS,
  type SlashCommandContext,
  tryDispatchSlashCommand,
} from "../src/tui/slash-commands.js";

/**
 * Unit-level coverage for `/model`. Validates the dispatcher routes the
 * command, the handler validates arguments, and the canonicalized name
 * flows back into the transcript line. The full keyboard path is
 * exercised by `tui-slash-commands.test.ts`; this file keeps the focused
 * branch coverage cheap.
 */
function makeContext(
  overrides: Partial<SlashCommandContext> & {
    onSetModel?: (model: string) => { modelName: string };
  } = {},
): SlashCommandContext & { blocks: Array<{ label: string | null; body: string; fg: string }> } {
  const blocks: Array<{ label: string | null; body: string; fg: string }> = [];
  const setModel =
    overrides.setModel ?? overrides.onSetModel ?? ((model: string) => ({ modelName: model }));
  return {
    pasteController: {} as never,
    copyController: {} as never,
    transcriptWriter: {} as never,
    appendBlock: (label, body, fg) => {
      blocks.push({ label, body, fg });
    },
    onReset: () => {},
    setModel,
    ...overrides,
    blocks,
  };
}

describe("/model slash command", () => {
  test("/model is registered in the autocomplete catalog", () => {
    const item = BUILT_IN_SLASH_COMMAND_ITEMS.find((row) => row.name === "model");
    expect(item).toBeDefined();
    expect(item?.group).toBe("commands");
  });

  test("/model <name> dispatches setModel and writes a [model] block", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    const handled = tryDispatchSlashCommand("/model sonnet-4.6", ctx);

    expect(handled).toBe(true);
    expect(calls).toEqual(["sonnet-4.6"]);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.label).toBe("[model]");
    expect(ctx.blocks[0]!.body).toContain("sonnet-4.6");
    expect(ctx.blocks[0]!.body).toContain("next turn");
  });

  test("/model with no argument prints usage and never calls setModel", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    const handled = tryDispatchSlashCommand("/model", ctx);

    expect(handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.body).toContain("Usage:");
  });

  test("/model surfaces setModel errors through an error-colored block", () => {
    const ctx = makeContext({
      setModel: () => {
        throw new Error("unknown model: bogus");
      },
    });

    const handled = tryDispatchSlashCommand("/model bogus", ctx);

    expect(handled).toBe(true);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.label).toBe("[model]");
    expect(ctx.blocks[0]!.body).toBe("unknown model: bogus");
  });
});
