import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "bun:test";

import {
  applyEvictionHorizon,
  calculateWireBytes,
  calculateWireTokens,
  createInitialHorizon,
  findEvictionHorizon,
  IMAGE_WIRE_TOKEN_ESTIMATE,
} from "../src/turn-runner/wire-shaping.js";

function userText(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistantToolCall(toolCallId: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }],
    timestamp,
  } as unknown as AgentMessage;
}

function toolResultText(toolCallId: string, text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

describe("applyEvictionHorizon", () => {
  test("returns input unchanged when horizon is zero", () => {
    const messages = [userText("a", 1), assistantToolCall("t1", 2), toolResultText("t1", "ok", 3)];
    expect(applyEvictionHorizon(messages, 0)).toBe(messages);
  });

  test("drops messages whose timestamp is at or before the horizon", () => {
    const messages = [userText("oldest", 1), userText("middle", 2), userText("newest", 3)];
    const out = applyEvictionHorizon(messages, 1);
    expect(out.map((m) => (m as { content: { text: string }[] }).content[0]?.text)).toEqual([
      "middle",
      "newest",
    ]);
  });

  test("sweeps past orphan toolResult and assistant at the new head when the cut splits a tool pair", () => {
    // Cut falls right after the assistant tool_use. Without the sweep the
    // dispatched list would start with `toolResult` (no matching assistant
    // tool_use earlier in the conversation) and the provider API would
    // reject the request.
    const messages = [
      userText("user1", 1),
      assistantToolCall("toolu_1", 2),
      toolResultText("toolu_1", "ok", 3),
      userText("user2", 4),
      assistantToolCall("toolu_2", 5),
      toolResultText("toolu_2", "ok", 6),
      userText("user3", 7),
    ];

    const out = applyEvictionHorizon(messages, 2);

    expect(out[0]?.role).toBe("user");
    expect((out[0] as { content: { text: string }[] }).content[0]?.text).toBe("user2");
    expect(out).toHaveLength(4);
  });

  test("returns an empty list when no user message remains after the horizon", () => {
    const messages = [
      userText("only-user", 1),
      assistantToolCall("toolu_1", 2),
      toolResultText("toolu_1", "ok", 3),
    ];
    expect(applyEvictionHorizon(messages, 1)).toEqual([]);
  });
});

describe("findEvictionHorizon", () => {
  test("does not advance when only the latest message would remain (MIN_HISTORY_TAIL floor)", () => {
    const horizon = findEvictionHorizon([userText("only", 1)], 0, () => false);
    expect(horizon).toBe(0);
  });

  test("advances just past as many oldest messages as the predicate requires", () => {
    const messages = [
      userText("a", 10),
      userText("b", 20),
      userText("c", 30),
      userText("d", 40),
      userText("e", 50),
    ];
    // Satisfy predicate only when at most 2 messages remain.
    const horizon = findEvictionHorizon(messages, 0, (candidate) => candidate.length <= 2);
    // Horizon should sit at message c's timestamp (30): dropping a, b, c
    // leaves [d, e] and the predicate returns true on that step.
    expect(horizon).toBe(30);
    expect(applyEvictionHorizon(messages, horizon)).toHaveLength(2);
  });

  test("never retreats from the caller's existing horizon", () => {
    const messages = [userText("a", 10), userText("b", 20), userText("c", 30)];
    // Predicate is already satisfied, but caller's horizon is past message a.
    // Returned horizon must be >= 15.
    const horizon = findEvictionHorizon(messages, 15, () => true);
    expect(horizon).toBeGreaterThanOrEqual(15);
  });
});

describe("calculateWireBytes", () => {
  test("sums base64 length for image blocks", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "image", data: "A".repeat(1024), mimeType: "image/png" }],
        timestamp: 1,
      } as AgentMessage,
    ];
    expect(calculateWireBytes(messages)).toBe(1024);
  });

  test("sums UTF-16 length for text blocks", () => {
    const messages = [userText("x".repeat(500), 1)];
    expect(calculateWireBytes(messages)).toBe(500);
  });

  test("counts thinking text and signature via the JSON.stringify fallback", () => {
    // Reasoning-heavy sessions can carry hundreds of thinking blocks where
    // the opaque `thinkingSignature` dominates wire size, so the catch-all
    // path must include it. Asserted as a lower bound (text + signature
    // lengths) plus the JSON envelope on top.
    const thinking = "y".repeat(200);
    const signature = "s".repeat(1500);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking, thinkingSignature: signature }],
        timestamp: 1,
      } as unknown as AgentMessage,
    ];
    const bytes = calculateWireBytes(messages);
    expect(bytes).toBeGreaterThanOrEqual(thinking.length + signature.length);
    expect(bytes).toBeLessThan(thinking.length + signature.length + 100);
  });
});

describe("calculateWireTokens", () => {
  test("charges a fixed per-image estimate regardless of base64 size", () => {
    // The whole point of the wire-token path: a 2 MB inline image must not
    // score ~500K tokens by `ceil(bytes/4)`. If a regression re-routes
    // images through the byte length, this test catches it.
    const small: AgentMessage = {
      role: "user",
      content: [{ type: "image", data: "A".repeat(64) }],
      timestamp: 1,
    } as AgentMessage;
    const huge: AgentMessage = {
      role: "user",
      content: [{ type: "image", data: "A".repeat(2 * 1024 * 1024) }],
      timestamp: 2,
    } as AgentMessage;
    expect(calculateWireTokens([small])).toBe(IMAGE_WIRE_TOKEN_ESTIMATE);
    expect(calculateWireTokens([huge])).toBe(IMAGE_WIRE_TOKEN_ESTIMATE);
  });

  test("uses ceil(chars/4) for text blocks", () => {
    const messages = [userText("x".repeat(401), 1)];
    expect(calculateWireTokens(messages)).toBe(Math.ceil(401 / 4));
  });

  test("sums image, text, and structured contributions across messages", () => {
    const messages: AgentMessage[] = [
      userText("hello world", 1),
      {
        role: "user",
        content: [{ type: "image", data: "A".repeat(10_000) }],
        timestamp: 2,
      } as AgentMessage,
      assistantToolCall("toolu_1", 3),
    ];
    const textTokens = Math.ceil("hello world".length / 4);
    const structuredJson = JSON.stringify({
      type: "toolCall",
      id: "toolu_1",
      name: "bash",
      arguments: {},
    });
    const structuredTokens = Math.ceil(structuredJson.length / 4);
    expect(calculateWireTokens(messages)).toBe(
      textTokens + IMAGE_WIRE_TOKEN_ESTIMATE + structuredTokens,
    );
  });
});

describe("createInitialHorizon", () => {
  test("returns a fresh sticky horizon at zero", () => {
    const a = createInitialHorizon();
    const b = createInitialHorizon();
    expect(a).toEqual({ evictionHorizon: 0 });
    expect(a).not.toBe(b);
  });
});
