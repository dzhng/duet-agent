import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_SLASH_COMMAND_ITEMS,
  applyInlineSlashCommands,
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
  // Controllers are intentionally omitted — they are optional on
  // SlashCommandContext, and these tests only exercise commands that
  // do not touch them. Leaves the test fixtures honest about which
  // surfaces they actually depend on.
  return {
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

describe("applyInlineSlashCommands", () => {
  test("fires /model from the middle of a prompt and strips it from the residue", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    // The slash form is removed from the residue so the agent does not
    // have to re-parse local UI commands as user content. Words on
    // either side stay separated by a single space.
    const { handledCommands, residue } = applyInlineSlashCommands(
      "hey /model sonnet-4.6 please refactor this file",
      ctx,
    );

    expect(calls).toEqual(["sonnet-4.6"]);
    expect(handledCommands).toEqual(["model"]);
    expect(residue).toBe("hey please refactor this file");
  });

  test("fires multiple inline commands in one prompt and strips both from the residue", () => {
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

    const { handledCommands, residue } = applyInlineSlashCommands(
      "/model opus-4.7 think hard /thinking high about this",
      ctx,
    );

    expect(setModelCalls).toEqual(["opus-4.7"]);
    expect(setThinkingCalls).toEqual(["high"]);
    // Order follows BUILT_IN_SLASH_COMMANDS iteration, not message order;
    // what matters is that both commands fired.
    expect(handledCommands).toContain("model");
    expect(handledCommands).toContain("thinking");
    expect(residue).toBe("think hard about this");
  });

  test("residue is empty when the whole prompt was inline slash commands (so callers can skip the turn)", () => {
    const setModelCalls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        setModelCalls.push(model);
        return { modelName: model };
      },
    });

    const { handledCommands, residue } = applyInlineSlashCommands("/model sonnet-4.6", ctx);

    expect(setModelCalls).toEqual(["sonnet-4.6"]);
    expect(handledCommands).toEqual(["model"]);
    // Empty residue is the signal callers use to skip dispatching
    // the prompt to the agent — mirrors how the whole-message
    // dispatcher returns early before reaching dispatchTurn.
    expect(residue).toBe("");
  });

  test("never matches /name embedded inside another token (URLs, paths)", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    const { handledCommands, residue } = applyInlineSlashCommands(
      "check https://example.com/model/foo and /usr/local/bin",
      ctx,
    );

    expect(calls).toEqual([]);
    expect(handledCommands).toEqual([]);
    // Nothing matched, residue is the original message verbatim.
    expect(residue).toBe("check https://example.com/model/foo and /usr/local/bin");
  });

  test("/feedback inside a prompt is NOT fired (rest-of-line arg, no inline shape)", () => {
    const ctx = makeContext();
    const { handledCommands, residue } = applyInlineSlashCommands(
      "please send /feedback this rocks for me",
      ctx,
    );
    expect(handledCommands).toEqual([]);
    expect(residue).toBe("please send /feedback this rocks for me");
  });

  test("inline /model with a rejected name renders an error block and never mutates config", () => {
    // Setter rejects exactly the same way Session.setModel would reject
    // an unresolvable shorthand: throw before mutating. The inline path
    // must surface that as a red [model] block, not crash the dispatch,
    // so the original prompt still runs on the previously-configured
    // model.
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        throw new Error("Unknown model shorthand: bogus");
      },
    });

    const { handledCommands } = applyInlineSlashCommands(
      "hey can you review this /model bogus and reply",
      ctx,
    );

    // Handler ran (it was matched and dispatched) but setModel threw.
    // The handler counts as "handled" because the side effect attempt
    // fired; the model itself is unchanged because no successful return
    // reached the config layer.
    expect(calls).toEqual(["bogus"]);
    expect(handledCommands).toEqual(["model"]);
    const block = ctx.blocks.find((b) => b.label === "[model]");
    expect(block?.body).toBe("Unknown model shorthand: bogus");
    // The handler renders error blocks with the system's error color so
    // the TUI shows them in red — we assert it is a non-default fg, not
    // the exact ANSI sequence, so the theme can evolve without breaking
    // this test.
    expect(block?.fg).toBeTruthy();
  });

  test("inline /thinking with a rejected level renders an error block and never mutates config", () => {
    const calls: string[] = [];
    const ctx = makeContext({
      setThinkingLevel: (level) => {
        calls.push(level);
        throw new Error(
          "Unknown thinking level: ultra. Expected one of minimal, low, medium, high, xhigh.",
        );
      },
    });

    const { handledCommands } = applyInlineSlashCommands(
      "please /thinking ultra and answer carefully",
      ctx,
    );

    expect(calls).toEqual(["ultra"]);
    expect(handledCommands).toEqual(["thinking"]);
    const block = ctx.blocks.find((b) => b.label === "[thinking]");
    expect(block?.body).toContain("Unknown thinking level: ultra");
    expect(block?.fg).toBeTruthy();
  });

  test("inline /model with no argument is left as literal text (token shape requires an arg)", () => {
    // Inline-token shape requires `[ \t]+(\S+)` after the command name.
    // A bare `/model` mid-prompt has no inline match, so it falls
    // through to the agent unchanged — the user gets no error block and
    // no surprise config swap. Whole-message `/model` (handled by the
    // dispatcher) is the path that prints usage; this one explicitly is
    // not.
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        return { modelName: model };
      },
    });

    const { handledCommands, residue } = applyInlineSlashCommands(
      "please look at this and /model",
      ctx,
    );

    expect(calls).toEqual([]);
    expect(handledCommands).toEqual([]);
    expect(ctx.blocks).toEqual([]);
    expect(residue).toBe("please look at this and /model");
  });

  test("inline /model treats the next non-whitespace token as the arg (even if it is not a model name)", () => {
    // Without scoping the arg to look like a model name, the next word
    // after `/model` is the arg. The parser cannot distinguish "the
    // model name" from "a stray word that happens to follow /model".
    // We surface the resolver error so the user notices, rather than
    // silently picking up `please` as a model.
    const calls: string[] = [];
    const ctx = makeContext({
      setModel: (model) => {
        calls.push(model);
        throw new Error(`Unknown model shorthand: ${model}`);
      },
    });

    const { handledCommands, residue } = applyInlineSlashCommands(
      "hey /model please look at this",
      ctx,
    );

    expect(calls).toEqual(["please"]);
    expect(handledCommands).toEqual(["model"]);
    expect(ctx.blocks.find((b) => b.label === "[model]")?.body).toBe(
      "Unknown model shorthand: please",
    );
    // `please` was consumed as the (failing) arg, so it is stripped
    // from the residue along with the slash form itself.
    expect(residue).toBe("hey look at this");
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

    const { handledCommands, residue } = applyInlineSlashCommands(
      "/model sonnet-4.6 also /reset please",
      ctx,
      { onlyCommands: new Set(["model", "thinking"]) },
    );

    expect(setModelCalls).toEqual(["sonnet-4.6"]);
    expect(handledCommands).toEqual(["model"]);
    // /reset stays in the residue because it was filtered out of the
    // inline-eligible set — the CLI intentionally ignores it.
    expect(residue).toBe("also /reset please");
  });
});
