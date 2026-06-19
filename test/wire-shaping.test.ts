import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "bun:test";

import { CHARS_PER_TOKEN } from "../src/memory/observational.js";
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

  test("anchors on the next user turn when one survives the horizon", () => {
    // Cut falls right after the assistant tool_use. The dispatched list
    // must not start with `toolResult` (no matching assistant tool_use
    // earlier in the conversation) or the provider API rejects it. A real
    // user turn survives downstream, so it is the preferred anchor.
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

  test("keeps the assistant-anchored tail when no user turn survives the horizon", () => {
    // A long autonomous run (tool loop, no intervening user input) leaves a
    // post-horizon tail with no user turn. Skipping to a user message would
    // walk off the end and return [], starving the wire and letting the
    // model loop forever (session_rUjMi_pUNzhB). Anchor on the first
    // non-orphan message instead: here that is the surviving assistant
    // tool_use, whose result follows it, so the head is provider-valid.
    const messages = [
      userText("only-user", 1),
      assistantToolCall("toolu_1", 2),
      toolResultText("toolu_1", "ok", 3),
    ];
    const out = applyEvictionHorizon(messages, 1);
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });

  test("drops leading orphan tool results when no user turn survives the horizon", () => {
    // The cut splits a tool pair AND no user turn follows. The leading
    // toolResult is an orphan (its tool_use was evicted), so it must be
    // dropped; the next assistant tool_use is the first valid head.
    const messages = [
      userText("only-user", 1),
      assistantToolCall("toolu_1", 2),
      toolResultText("toolu_1", "ok", 3),
      assistantToolCall("toolu_2", 4),
      toolResultText("toolu_2", "ok", 5),
    ];
    // horizon=2 drops user + first assistant, leaving an orphan toolResult
    // at the head.
    const out = applyEvictionHorizon(messages, 2);
    expect(out[0]?.role).toBe("assistant");
    expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
  });
});

describe("findEvictionHorizon", () => {
  test("does not advance when only the latest message would remain (MIN_HISTORY_TAIL floor)", () => {
    expect(findEvictionHorizon([userText("only", 1)], 0, () => false)).toBe(0);
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
    // Horizon sits at message c's timestamp (30): dropping a, b, c leaves
    // [d, e] and the predicate returns true on that step.
    expect(horizon).toBe(30);
    expect(applyEvictionHorizon(messages, horizon)).toHaveLength(2);
  });

  test("never retreats from the caller's existing horizon", () => {
    const messages = [userText("a", 10), userText("b", 20), userText("c", 30)];
    // Predicate is already satisfied, but caller's horizon is past message a.
    expect(findEvictionHorizon(messages, 15, () => true)).toBeGreaterThanOrEqual(15);
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

  test("uses ceil(chars / CHARS_PER_TOKEN) for text blocks", () => {
    const messages = [userText("x".repeat(401), 1)];
    expect(calculateWireTokens(messages)).toBe(Math.ceil(401 / CHARS_PER_TOKEN));
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
    const textTokens = Math.ceil("hello world".length / CHARS_PER_TOKEN);
    const structuredJson = JSON.stringify({
      type: "toolCall",
      id: "toolu_1",
      name: "bash",
      arguments: {},
    });
    const structuredTokens = Math.ceil(structuredJson.length / CHARS_PER_TOKEN);
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
