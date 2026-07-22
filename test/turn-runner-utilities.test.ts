import { describe, expect, test } from "bun:test";
import { runShellCommand, ShellCommandError } from "../src/turn-runner/shell-state-handle.js";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
} from "../src/turn-runner/state-machine-decisions.js";
import {
  addUsage,
  addUsageByModel,
  usageFromAiSdk,
  usageFromMessages,
} from "../src/turn-runner/usage-accounting.js";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelUsageEntry, TurnTokenUsage } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";

describe("turn-runner shell execution utilities", () => {
  test("parses structured output values", () => {
    expect(parseStructuredOutput('{"id":42,"ok":true}')).toEqual({ id: 42, ok: true });
    expect(parseStructuredOutput("done")).toEqual({ result: "done" });
    expect(parseStructuredOutput("7")).toEqual({ result: 7 });
    expect(parseStructuredOutput("")).toEqual({});
  });

  test("parses only JSON objects for poll output", () => {
    expect(parseJsonObject('{"ready":true}')).toEqual({ ready: true });
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject('"ready"')).toEqual({});
    expect(parseJsonObject("not json")).toEqual({});
  });

  test("renders nested input paths and serializes non-string values", () => {
    const rendered = renderTemplate(
      "send {{ input.user.name }} {{ input.count }} {{ input.missing }}",
      {
        user: { name: "Ada" },
        count: 3,
      },
    );

    expect(rendered).toBe("send Ada 3 ");
  });

  test("captures streamed stdout and stderr when aborted", async () => {
    const abortController = new AbortController();
    const command = "printf partial-out; printf partial-err >&2; sleep 2";
    const result = runShellCommand(command, { cwd: process.cwd(), signal: abortController.signal });

    await new Promise((resolve) => setTimeout(resolve, 50));
    abortController.abort();

    await expect(result).rejects.toMatchObject({
      output: {
        stdout: "partial-out",
        stderr: "partial-err",
      },
    });
  });

  test("inherits DUET_API_KEY from process.env into spawned bash scripts", async () => {
    // The CLI loads DUET_API_KEY into process.env (from the shared duet env
    // file or directly from the user's env) and the turn runner shells out
    // through runShellCommand. Bash scripts driven by script-state machines
    // must see that token so they can authenticate against duet.so just like
    // the agent does — guarded here against an accidental `env: {}` regression
    // in the spawn options.
    const previous = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "duet_gt_inherit_marker";
    try {
      const result = await runShellCommand('printf "%s" "$DUET_API_KEY"', {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
      expect(result).toEqual({
        stdout: "duet_gt_inherit_marker",
        stderr: "",
        exitCode: 0,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.DUET_API_KEY;
      } else {
        process.env.DUET_API_KEY = previous;
      }
    }
  });

  test("honors success codes and reports non-success output", async () => {
    await expect(
      runShellCommand("printf ok; exit 7", {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        successCodes: [7],
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 7 });

    try {
      await runShellCommand("printf nope; exit 9", {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
      throw new Error("Expected shell command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ShellCommandError);
      expect(error).toMatchObject({ output: { stdout: "nope", exitCode: 9 } });
    }
  });
});

describe("turn-runner usage accounting", () => {
  test("normalizes AI SDK usage and prices it with the resolved pi model", () => {
    const model = {
      id: "anthropic/test-model",
      name: "Test model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 200_000,
      maxTokens: 8_000,
    } satisfies Model<"anthropic-messages">;

    const usage = usageFromAiSdk(
      {
        inputTokens: 130,
        inputTokenDetails: {
          noCacheTokens: 100,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        },
        outputTokens: 30,
        outputTokenDetails: { textTokens: 20, reasoningTokens: 10 },
        totalTokens: 160,
      },
      model,
    );

    expect(usage).toMatchObject({
      input: 100,
      output: 30,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 160,
    });
    expect(usage.cost.input).toBeCloseTo(0.0002, 12);
    expect(usage.cost.output).toBeCloseTo(0.00012, 12);
    expect(usage.cost.cacheRead).toBeCloseTo(0.000004, 12);
    expect(usage.cost.cacheWrite).toBeCloseTo(0.000025, 12);
    expect(usage.cost.total).toBeCloseTo(0.000349, 12);
  });

  test("keeps plan-covered AI SDK usage at zero cost", () => {
    const model = {
      id: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 200_000,
      maxTokens: 10_000,
    } satisfies Model<"openai-codex-responses">;

    const usage = usageFromAiSdk(
      {
        inputTokens: 120,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 },
        outputTokens: 30,
        outputTokenDetails: { textTokens: 30, reasoningTokens: 0 },
        totalTokens: 150,
      },
      model,
      { planCovered: true },
    );

    expect(usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  test("adds protocol and provider usage values", () => {
    const total = addUsage(
      {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      {
        input: 5,
        output: 7,
        cacheRead: 11,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.13 },
      },
    );

    expect(
      addUsage(total, {
        input: 1,
        output: 4,
        cacheRead: 6,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({
      input: 8,
      output: 14,
      totalTokens: 22,
      cacheRead: 17,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.13 },
    });
  });

  test("folds two distinct models into separate entries whose costs sum to the combined total", () => {
    const opus: TurnTokenUsage = {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
    };
    const haiku: TurnTokenUsage = {
      input: 40,
      output: 8,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 48,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };

    const afterFirst = addUsageByModel(undefined, "anthropic/opus", "duet-gateway", opus);
    const breakdown = addUsageByModel(afterFirst, "anthropic/haiku", "duet-gateway", haiku);

    expect(breakdown).toHaveLength(2);
    expect(breakdown.find((e) => e.model === "anthropic/opus")?.usage).toEqual(opus);
    expect(breakdown.find((e) => e.model === "anthropic/haiku")?.usage).toEqual(haiku);

    // Core invariant: per-model cost totals sum to the combined turn total.
    const combined = addUsage(opus, haiku)!;
    const summed = breakdown.reduce((acc, e) => acc + e.usage.cost.total, 0);
    expect(summed).toBeCloseTo(combined.cost.total, 10);
    expect(summed).toBeCloseTo(0.18, 10);
  });

  test("merges repeated usage for the same model into a single entry", () => {
    const first: TurnTokenUsage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    };
    const second: TurnTokenUsage = {
      input: 30,
      output: 15,
      cacheRead: 7,
      cacheWrite: 0,
      totalTokens: 45,
      cost: { input: 0.03, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 },
    };

    const breakdown = addUsageByModel(
      addUsageByModel(undefined, "anthropic/opus", "duet-gateway", first),
      "anthropic/opus",
      "duet-gateway",
      second,
    );

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]).toEqual({
      model: "anthropic/opus",
      transport: { provider: "duet-gateway", billing: "metered" },
      usage: addUsage(first, second)!,
    });
    expect(breakdown[0]!.usage.cost.total).toBeCloseTo(0.07, 10);
  });

  test("keeps the same model id separate across transport providers", () => {
    const usage: TurnTokenUsage = {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    };
    const rows = addUsageByModel(
      addUsageByModel(undefined, "shared-model", "openai-codex", usage),
      "shared-model",
      "duet-gateway",
      usage,
    );

    expect(rows.map((entry) => entry.transport.provider)).toEqual(["openai-codex", "duet-gateway"]);
  });

  test("never mutates the input list and clones it unchanged for falsy usage", () => {
    const original: ModelUsageEntry[] = [
      {
        model: "anthropic/opus",
        transport: { provider: "duet-gateway", billing: "metered" },
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
        },
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));

    const unchanged = addUsageByModel(original, "anthropic/opus", "duet-gateway", undefined);
    expect(unchanged).toEqual(original);
    expect(unchanged).not.toBe(original);

    // Folding new usage must not write back into the source list.
    addUsageByModel(original, "anthropic/opus", "duet-gateway", {
      input: 9,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.99 },
    });
    expect(original).toEqual(snapshot);
  });

  test("extracts usage from assistant messages", () => {
    const usage = usageFromMessages([
      { role: "user", content: "hello", timestamp: 1 },
      createAssistantMessage({
        usage: {
          input: 4,
          output: 8,
          cacheRead: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      }),
    ]);

    expect(usage).toEqual({
      input: 4,
      output: 8,
      totalTokens: 12,
      cacheRead: 2,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
  });
});
