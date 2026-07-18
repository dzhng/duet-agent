import { describe, expect, test } from "bun:test";
import { applyInlineSlashCommandsToCliConfig } from "../src/cli/inline-slash.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import type { TurnRunnerConfig } from "../src/types/config.js";

function makeConfig(overrides: Partial<TurnRunnerConfig> = {}): TurnRunnerConfig {
  return {
    model: "anthropic:claude-opus-4-7",
    memoryDbPath: false,
    skillDiscovery: { includeDefaults: false },
    ...overrides,
  } as TurnRunnerConfig;
}

function makeLog(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("applyInlineSlashCommandsToCliConfig", () => {
  test("inline /model with a valid provider-pinned name mutates config and strips it from residue", () => {
    const config = makeConfig();
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "hey can you review this /model anthropic:claude-sonnet-5-1",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-sonnet-5-1");
    expect(log.lines.join("")).toContain(
      "[model] next turn will use anthropic:claude-sonnet-5-1 (pinned — routing suspended)",
    );
    expect(residue).toBe("hey can you review this");
  });

  test("whole-prompt /model returns an empty residue so the CLI can skip the agent turn", () => {
    // This is the `duet "/model X"` case: the whole prompt is just a
    // slash command. The CLI mutates config and returns "" so run.ts
    // unsets `prompt` and never dispatches an agent turn.
    const config = makeConfig();
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "/model anthropic:claude-sonnet-5-1",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-sonnet-5-1");
    expect(residue).toBe("");
  });

  test("inline /model accepts a virtual tier and reports routed selection", () => {
    const config = makeConfig();
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "review this /model frontier",
      config,
      log.write,
    );

    expect(config.model).toBe("frontier");
    expect(log.lines.join("")).toContain("[model] next turn routes via frontier");
    expect(residue).toBe("review this");
  });

  test("inline /model validates virtual names against the loaded replacement table", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "custom";
    table.tiers = { custom: table.tiers.economy! };
    const config = makeConfig();
    const log = makeLog();

    applyInlineSlashCommandsToCliConfig("/model custom", config, log.write, table);
    expect(config.model).toBe("custom");
    expect(log.lines.join("")).toContain("routes via custom");

    applyInlineSlashCommandsToCliConfig("/model frontier", config, log.write, table);
    expect(config.model).toBe("custom");
    expect(log.lines.join("")).toContain('Unknown virtual model tier "frontier"');
  });

  test("whole-prompt /model X /thinking Y applies both swaps and still returns empty residue", () => {
    const config = makeConfig({ thinkingLevel: "medium" });
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "/model anthropic:claude-sonnet-5-1 /thinking high",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-sonnet-5-1");
    expect(config.thinkingLevel).toBe("high");
    expect(residue).toBe("");
  });

  test("inline /thinking with a valid level mutates config and confirms via log", () => {
    const config = makeConfig({ thinkingLevel: "medium" });
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "please /thinking high and reply",
      config,
      log.write,
    );

    expect(config.thinkingLevel).toBe("high");
    expect(log.lines.join("")).toContain("[thinking] next turn will think at high");
    expect(residue).toBe("please and reply");
  });

  test("inline /thinking reports route-owned effort without changing routed config", () => {
    const config = makeConfig({ model: "frontier", thinkingLevel: "medium" });
    const log = makeLog();

    applyInlineSlashCommandsToCliConfig("/thinking high", config, log.write);

    expect(config.thinkingLevel).toBe("medium");
    expect(log.lines.join("")).toContain("route effort owns thinking while routing via frontier");
  });

  test("inline /model with an unresolvable shorthand never mutates config and logs the resolver error", () => {
    // This is the "what happens if the arg is wrong" path. The resolver
    // throws — applyInline... must swallow the throw, leave config.model
    // intact, and surface the resolver's exact message under [model] so
    // the user sees what went wrong instead of a silent swap.
    const config = makeConfig();
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "hey /model totally-not-a-real-model please review this",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-opus-4-7");
    const joined = log.lines.join("");
    expect(joined).toMatch(/\[model\]/);
    expect(joined).toMatch(/totally-not-a-real-model/);
    // No success confirmation should have been written.
    expect(joined).not.toMatch(/next turn will use/);
    // Even though validation failed, the slash form is still stripped
    // from the residue — the parser already committed to treating
    // `totally-not-a-real-model` as the arg, so leaving it in would be
    // worse (the agent would see a half-mangled prompt).
    expect(residue).toBe("hey please review this");
  });

  test("inline /thinking with an unknown level never mutates config and lists the legal values", () => {
    const config = makeConfig({ thinkingLevel: "medium" });
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "/thinking ultra please go",
      config,
      log.write,
    );

    expect(config.thinkingLevel).toBe("medium");
    const joined = log.lines.join("");
    expect(joined).toContain("[thinking] Unknown thinking level: ultra");
    expect(joined).toContain("minimal, low, medium, high, xhigh");
    expect(joined).not.toMatch(/next turn will think at/);
    expect(residue).toBe("please go");
  });

  test("trailing /model with no following token is left in the residue (token shape requires an arg)", () => {
    // The token-shape inline pattern requires `[ \t]+(\S+)` after the
    // command name. With nothing following, there is no match, so the
    // slash form is not stripped and falls through to the agent.
    const config = makeConfig();
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "please look at this and /model",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-opus-4-7");
    expect(log.lines).toEqual([]);
    expect(residue).toBe("please look at this and /model");
  });

  test("a bad /model followed by a good /thinking still applies the /thinking swap", () => {
    // Each inline command is independent: a validation failure on one
    // must not stop the loop from applying the others.
    const config = makeConfig({ thinkingLevel: "medium" });
    const log = makeLog();

    const { residue } = applyInlineSlashCommandsToCliConfig(
      "hey /model totally-not-real and /thinking high please",
      config,
      log.write,
    );

    expect(config.model).toBe("anthropic:claude-opus-4-7");
    expect(config.thinkingLevel).toBe("high");
    const joined = log.lines.join("");
    expect(joined).toContain("[model]");
    expect(joined).toContain("[thinking] next turn will think at high");
    expect(residue).toBe("hey and please");
  });
});
