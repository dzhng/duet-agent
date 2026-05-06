import { describe, expect, test } from "bun:test";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
} from "../src/turn-runner/shell-exec.js";
import { addUsage, usageFromMessages } from "../src/turn-runner/usage-accounting.js";
import { createAssistantMessage, createUsage } from "./helpers/messages.js";

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
});

describe("turn-runner usage accounting", () => {
  test("adds protocol and provider usage values", () => {
    const total = addUsage(
      { inputTokens: 2, outputTokens: 3 },
      createUsage({
        input: 5,
        output: 7,
        cacheRead: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.13 },
      }),
    );

    expect(addUsage(total, { inputTokens: 1, outputTokens: 4, cachedInputTokens: 6 })).toEqual({
      inputTokens: 8,
      outputTokens: 14,
      cachedInputTokens: 17,
      costUsd: 0.13,
    });
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
      inputTokens: 4,
      outputTokens: 8,
      cachedInputTokens: 2,
      costUsd: 0.25,
    });
  });
});
