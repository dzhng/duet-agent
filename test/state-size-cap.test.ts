import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnState } from "../src/types/protocol.js";
import {
  enforceStateSizeCap,
  serializeEnvelope,
  STATE_FILE_MAX_BYTES,
  type StoredEnvelopeShape,
} from "../src/session/state-size-cap.js";

function userMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function assistantToolCall(id: string, padding = ""): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `thinking ${padding}` },
      { type: "toolCall", toolCallId: id, name: "bash", arguments: {} },
    ],
    stopReason: "end_turn",
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, output: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text: output }],
    isError: false,
  } as unknown as AgentMessage;
}

function envelope(messages: AgentMessage[], extra: Partial<TurnState> = {}): StoredEnvelopeShape {
  return {
    sessionId: "test-session",
    updatedAt: 1700000000000,
    sessionCostUsd: 0,
    state: {
      status: "running",
      mode: "auto",
      ...extra,
      agent: {
        status: "running",
        messages,
      },
    } as TurnState,
  };
}

describe("enforceStateSizeCap", () => {
  test("no-op when payload already fits and has no integrity issues", () => {
    const messages: AgentMessage[] = [userMessage("hi"), userMessage("there")];
    const payload = envelope(messages);
    const result = enforceStateSizeCap(payload, STATE_FILE_MAX_BYTES);

    expect(result.evicted).toBe(0);
    expect(result.payload).toBe(payload);
    expect(result.bytes).toBe(serializeEnvelope(payload).length);
    expect(result.payload.state?.agent.messages).toBe(messages);
  });

  test("evicts the oldest messages until payload fits the cap", () => {
    // Build a 4-message transcript where each message is ~2KB so we can use a
    // tight 5KB cap and assert exact eviction counts.
    const big = "x".repeat(2000);
    const messages: AgentMessage[] = [
      userMessage(`m0 ${big}`),
      userMessage(`m1 ${big}`),
      userMessage(`m2 ${big}`),
      userMessage(`m3 ${big}`),
    ];
    const payload = envelope(messages);
    const cap = 5 * 1024;

    const result = enforceStateSizeCap(payload, cap);

    expect(result.bytes).toBeLessThanOrEqual(cap);
    expect(result.evicted).toBeGreaterThanOrEqual(2);
    const kept = result.payload.state!.agent.messages as AgentMessage[];
    // The newest message must always survive.
    expect((kept.at(-1) as { content: { text: string }[] }).content[0].text).toContain("m3");
    // None of the surviving messages may be older than what eviction kept.
    const keptTexts = kept.map((m) => (m as { content: { text: string }[] }).content[0].text);
    expect(keptTexts.some((t) => t.startsWith("m0"))).toBe(false);
  });

  test("drops a leading assistant message after eviction so the head is always user", () => {
    // Anthropic and OpenAI reject conversations whose first message is
    // `assistant`. Build a transcript where evicting the oldest user message
    // would leave an assistant at the head; the cap must drop it too.
    const huge = "a".repeat(8000);
    const messages: AgentMessage[] = [
      userMessage(`stale ${huge}`),
      assistantToolCall("call_1"),
      toolResult("call_1", "ok"),
      userMessage("recent"),
    ];
    const payload = envelope(messages);
    const cap = 4 * 1024;

    const result = enforceStateSizeCap(payload, cap);

    const kept = result.payload.state!.agent.messages as AgentMessage[];
    expect(kept.length).toBe(1);
    expect((kept[0] as { role: string }).role).toBe("user");
    expect((kept[0] as { content: { text: string }[] }).content[0].text).toBe("recent");
    expect(result.evicted).toBe(3);
  });

  test("drops a leading orphan tool-result after eviction", () => {
    // Order: oversized assistant tool call, its tool result, then a small
    // user message. Evicting the assistant call would orphan the tool result,
    // so the cap logic must drop both.
    const huge = "y".repeat(8000);
    const messages: AgentMessage[] = [
      assistantToolCall("call_1", huge),
      toolResult("call_1", "ok"),
      userMessage("follow-up"),
    ];
    const payload = envelope(messages);
    const cap = 4 * 1024;

    const result = enforceStateSizeCap(payload, cap);

    const kept = result.payload.state!.agent.messages as AgentMessage[];
    expect(kept.length).toBe(1);
    expect((kept[0] as { role: string }).role).toBe("user");
    expect(result.evicted).toBe(2);
  });

  test("never evicts below MIN_RETAINED_MESSAGES, even if still oversize", () => {
    // A single message bigger than the cap should be kept rather than
    // emptying the transcript — the runner needs at least one anchor.
    const giant = "z".repeat(10_000);
    const payload = envelope([userMessage(giant)]);
    const cap = 1024;

    const result = enforceStateSizeCap(payload, cap);

    expect(result.evicted).toBe(0);
    expect(result.payload.state!.agent.messages.length).toBe(1);
    expect(result.bytes).toBeGreaterThan(cap);
  });

  test("does not mutate the input payload", () => {
    const big = "q".repeat(3000);
    const messages: AgentMessage[] = [
      userMessage(`a ${big}`),
      userMessage(`b ${big}`),
      userMessage(`c ${big}`),
    ];
    const payload = envelope(messages);
    const before = serializeEnvelope(payload);
    enforceStateSizeCap(payload, 4 * 1024);

    expect(serializeEnvelope(payload)).toBe(before);
    expect(payload.state!.agent.messages.length).toBe(3);
  });

  test("preserves non-message envelope fields after trimming", () => {
    const big = "p".repeat(2500);
    const messages: AgentMessage[] = [
      userMessage(`first ${big}`),
      userMessage(`second ${big}`),
      userMessage(`third ${big}`),
    ];
    const payload: StoredEnvelopeShape = {
      ...envelope(messages, {
        todos: [{ id: "t1", content: "ship", status: "in_progress" }],
      } as Partial<TurnState>),
      sessionCostUsd: 1.23,
      lastUsage: {
        lastMessageUsage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      } as StoredEnvelopeShape["lastUsage"],
    };

    const result = enforceStateSizeCap(payload, 4 * 1024);

    expect(result.evicted).toBeGreaterThan(0);
    expect(result.payload.sessionCostUsd).toBe(1.23);
    expect(result.payload.lastUsage).toBe(payload.lastUsage);
    expect(result.payload.state!.todos).toEqual(payload.state!.todos);
    expect(result.payload.state!.mode).toBe("auto");
  });

  test("no-op when there are no agent messages to evict", () => {
    const payload: StoredEnvelopeShape = envelope([]);
    const result = enforceStateSizeCap(payload, 16);
    // Even though the envelope alone exceeds 16 bytes, we have nothing to
    // shed, so the function returns the original.
    expect(result.evicted).toBe(0);
    expect(result.payload).toBe(payload);
  });

  test("default cap is 100 MB", () => {
    expect(STATE_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  test("keeps paired tool-call/tool-result intact when both survive eviction", () => {
    // Build a transcript where eviction stops on an assistant tool-call, and
    // its matching tool-result is the very next surviving message. The pair
    // must remain intact — dropping the result would break the conversation.
    const stale = "s".repeat(4000);
    const messages: AgentMessage[] = [
      userMessage(`drop me ${stale}`),
      userMessage("new turn"),
      assistantToolCall("call_keep"),
      toolResult("call_keep", "result kept"),
      userMessage("after tool"),
    ];
    const payload = envelope(messages);
    const cap = 3 * 1024;

    const result = enforceStateSizeCap(payload, cap);

    const kept = result.payload.state!.agent.messages as AgentMessage[];
    const hasCall = kept.some((m) => {
      const content = (m as { content?: unknown[] }).content ?? [];
      return content.some(
        (b) =>
          (b as { type?: string }).type === "toolCall" &&
          (b as { toolCallId?: string }).toolCallId === "call_keep",
      );
    });
    const hasResult = kept.some((m) => (m as { toolCallId?: string }).toolCallId === "call_keep");
    // Either both survive together or both are evicted together. They never
    // appear in mismatched halves.
    expect(hasCall).toBe(hasResult);
  });
});
