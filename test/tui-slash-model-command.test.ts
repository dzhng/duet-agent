import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_SLASH_COMMAND_ITEMS,
  extractInlineSlashCommands,
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
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext & { blocks: Array<{ label: string | null; body: string; fg: string }> } {
  const blocks: Array<{ label: string | null; body: string; fg: string }> = [];
  const setModel = overrides.setModel ?? ((model: string) => ({ modelName: model }));
  const setThinkingLevel =
    overrides.setThinkingLevel ?? ((level: string) => ({ thinkingLevel: level }));
  return {
    pasteController: {} as never,
    copyController: {} as never,
    transcriptWriter: {} as never,
    appendBlock: (label, body, fg) => {
      blocks.push({ label, body, fg });
    },
    onReset: () => {},
    setModel,
    setThinkingLevel,
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

describe("/thinking slash command", () => {
  test("/thinking is registered in the autocomplete catalog", () => {
    const item = BUILT_IN_SLASH_COMMAND_ITEMS.find((row) => row.name === "thinking");
    expect(item).toBeDefined();
    expect(item?.group).toBe("commands");
  });

  test("/thinking <level> dispatches setThinkingLevel and writes a [thinking] block", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setThinkingLevel: (level) => {
        calls.push(level);
        return { thinkingLevel: level };
      },
    });

    const handled = tryDispatchSlashCommand("/thinking high", ctx);

    expect(handled).toBe(true);
    expect(calls).toEqual(["high"]);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.label).toBe("[thinking]");
    expect(ctx.blocks[0]!.body).toContain("high");
    expect(ctx.blocks[0]!.body).toContain("next turn");
  });

  test("/thinking with no argument prints usage and never calls setThinkingLevel", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setThinkingLevel: (level) => {
        calls.push(level);
        return { thinkingLevel: level };
      },
    });

    const handled = tryDispatchSlashCommand("/thinking", ctx);

    expect(handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.body).toContain("Usage:");
    expect(ctx.blocks[0]!.body).toContain("minimal");
    expect(ctx.blocks[0]!.body).toContain("xhigh");
  });

  test("/thinking surfaces setThinkingLevel errors through an error-colored block", () => {
    const ctx = makeContext({
      setThinkingLevel: () => {
        throw new Error("Unknown thinking level: bogus");
      },
    });

    const handled = tryDispatchSlashCommand("/thinking bogus", ctx);

    expect(handled).toBe(true);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]!.label).toBe("[thinking]");
    expect(ctx.blocks[0]!.body).toBe("Unknown thinking level: bogus");
  });
});

describe("extractInlineSlashCommands", () => {
  test("fires /model from the middle of a prompt without touching the message", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    // The message itself stays the caller's responsibility — the
    // extractor only triggers side effects, exactly like skills.
    const { handledCommands } = extractInlineSlashCommands(
      "hey /model sonnet-4.6 please refactor this file",
      ctx,
    );

    expect(calls).toEqual(["sonnet-4.6"]);
    expect(handledCommands).toEqual(["model"]);
  });

  test("fires multiple inline commands in one prompt", () => {
    const setModelCalls: string[] = [];
    const setThinkingCalls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        setModelCalls.push(model);
        return { modelName: model };
      },
      setThinkingLevel: (level) => {
        setThinkingCalls.push(level);
        return { thinkingLevel: level };
      },
    });

    const { handledCommands } = extractInlineSlashCommands(
      "/model opus-4.7 think hard /thinking high about this",
      ctx,
    );

    expect(setModelCalls).toEqual(["opus-4.7"]);
    expect(setThinkingCalls).toEqual(["high"]);
    // Order follows BUILT_IN_SLASH_COMMANDS iteration, not message order;
    // what matters is that both commands fired.
    expect(handledCommands).toContain("model");
    expect(handledCommands).toContain("thinking");
  });

  test("never matches /name embedded inside another token (URLs, paths)", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    const { handledCommands } = extractInlineSlashCommands(
      "check https://example.com/model/foo and /usr/local/bin",
      ctx,
    );

    expect(calls).toEqual([]);
    expect(handledCommands).toEqual([]);
  });

  test("/feedback inside a prompt is NOT fired (rest-of-line arg, no inline shape)", () => {
    const ctx = makeContext();
    const { handledCommands } = extractInlineSlashCommands(
      "please send /feedback this rocks for me",
      ctx,
    );
    expect(handledCommands).toEqual([]);
  });

  test("onlyCommands restricts which inline commands fire (used by the non-TUI CLI path)", () => {
    const setModelCalls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        setModelCalls.push(model);
        return { modelName: model };
      },
      onReset: () => {
        throw new Error("onReset must not run when filtered out");
      },
    });

    const { handledCommands } = extractInlineSlashCommands(
      "/model sonnet-4.6 also /reset please",
      ctx,
      { onlyCommands: new Set(["model", "thinking"]) },
    );

    expect(setModelCalls).toEqual(["sonnet-4.6"]);
    expect(handledCommands).toEqual(["model"]);
  });
});
