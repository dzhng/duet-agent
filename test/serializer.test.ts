import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { assistantText } from "../src/core/serializer.js";

describe("assistantText", () => {
  test("returns only the latest assistant text", () => {
    expect(assistantText([assistantMessage("first"), assistantMessage("second")])).toBe("second");
  });
});

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "unknown",
    provider: "unknown",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}
