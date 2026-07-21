import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  ADVISOR_INPUT_TARGET_TOKENS,
  ADVISOR_RECENT_MESSAGE_TARGET_TOKENS,
  buildAdvisorContext,
  captureAdvisorExecutorContext,
  type AdvisorContextSource,
} from "../src/model-routing/advisor-context.js";
import { ADVISOR_MAX_OUTPUT_TOKENS } from "../src/model-routing/advisor.js";

const TOOL_RESULT = `complete-result:${"r".repeat(2_400)}`;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "duet-gateway",
    model: "executor-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function build(messages: readonly Message[], tools: readonly Tool[] = []) {
  return buildAdvisorContext({
    context: { systemPrompt: "EXECUTOR SYSTEM", messages, tools },
    contextWindowTokens: 200_000,
    reservedOutputTokens: 2_048,
  });
}

function payload(text: string) {
  const json = text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n"));
  return JSON.parse(json) as {
    truncation: { omittedMessages: number };
    executorContext: { systemPrompt: string; messages: unknown[]; tools: Tool[] };
  };
}

describe("buildAdvisorContext", () => {
  test("reserves the documented compact advisor output allowance", () => {
    expect(ADVISOR_MAX_OUTPUT_TOKENS).toBe(2_048);
    expect(ADVISOR_INPUT_TARGET_TOKENS).toBe(64_000);
    expect(ADVISOR_RECENT_MESSAGE_TARGET_TOKENS).toBe(8_000);
    expect(build([]).metadata.inputTargetTokens).toBe(64_000);
  });

  test("captures a partial assistant message once for runtime and preview callers", async () => {
    const user = { role: "user" as const, content: "Start.", timestamp: 1 };
    const streaming = assistant([{ type: "text", text: "Still streaming." }]);
    const source: AdvisorContextSource = {
      state: {
        systemPrompt: "SYS",
        messages: [user],
        tools: [],
        streamingMessage: streaming,
      },
      convertToLlm: (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
    };

    expect((await captureAdvisorExecutorContext(source)).messages).toEqual([user, streaming]);
    source.state.messages = [user, streaming];
    expect((await captureAdvisorExecutorContext(source)).messages).toEqual([user, streaming]);
  });

  test("represents compacted history with observations while preserving the first task and recent tail", async () => {
    const task = { role: "user" as const, content: "ORIGINAL TASK", timestamp: 1 };
    const old = assistant([{ type: "text", text: "OLD EXECUTOR WORK" }]);
    const recent = { role: "user" as const, content: "RECENT EVIDENCE", timestamp: 3 };
    const observation = {
      role: "user" as const,
      content: "<local_observations>OLD WORK SUMMARY</local_observations>",
      timestamp: 4,
    };
    const source: AdvisorContextSource = {
      state: {
        systemPrompt: "SYS",
        messages: [task, old, recent],
        tools: [],
        streamingMessage: undefined,
      },
      convertToLlm: (messages) => messages as Message[],
    };

    const context = await captureAdvisorExecutorContext(source, {
      transformMessages: async () => [observation, recent],
    });
    const result = buildAdvisorContext({
      context,
      contextWindowTokens: 200_000,
      reservedOutputTokens: 2_048,
    });

    expect(payload(result.text).executorContext.messages).toEqual([
      { role: "user", content: task.content },
      { role: "user", content: observation.content },
      { role: "user", content: recent.content },
    ]);
    expect(result.text).toContain("OLD WORK SUMMARY");
    expect(result.text).not.toContain("OLD EXECUTOR WORK");
    expect(result.metadata).toMatchObject({
      includedMessages: 3,
      compactedMessages: 1,
      omittedMessages: 0,
      truncated: false,
    });
  });

  test("preserves model-visible evidence without local message bookkeeping", () => {
    const tools = [
      {
        name: "edit_file",
        description: "Edit one repository file.",
        parameters: Type.Object({ path: Type.String(), patch: Type.String() }),
      },
    ];
    const messages: Message[] = [
      { role: "user", content: "Implement the fix.", timestamp: 1 },
      assistant([
        { type: "thinking", thinking: "private reasoning that the observer used to drop" },
        { type: "text", text: "I found the faulty boundary." },
        {
          type: "toolCall",
          id: "call-1",
          name: "edit_file",
          arguments: { path: "src/a.ts", patch: "full patch" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit_file",
        content: [{ type: "text", text: TOOL_RESULT }],
        details: { changed: true },
        isError: false,
        timestamp: 3,
      },
    ];

    const result = build(messages, tools);
    const parsed = payload(result.text);

    expect(parsed.executorContext).toEqual({
      systemPrompt: "EXECUTOR SYSTEM",
      messages: [
        { role: "user", content: "Implement the fix." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning that the observer used to drop" },
            { type: "text", text: "I found the faulty boundary." },
            {
              type: "toolCall",
              id: "call-1",
              name: "edit_file",
              arguments: { path: "src/a.ts", patch: "full patch" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit_file",
          content: [{ type: "text", text: TOOL_RESULT }],
          isError: false,
        },
      ],
      tools,
    });
    expect(result.text).toContain("private reasoning that the observer used to drop");
    expect(result.text).toContain(TOOL_RESULT);
    expect(result.metadata).toMatchObject({
      safetyMarginTokens: 4_000,
      includedMessages: 3,
      omittedMessages: 0,
      truncated: false,
      attachedImages: 0,
    });
  });

  test("removes signatures, diagnostics, accounting, timestamps, and tool details", () => {
    const message = assistant([
      {
        type: "thinking",
        thinking: "inspect the boundary",
        thinkingSignature: "opaque-thinking-replay-payload",
      },
      {
        type: "text",
        text: "Evidence found.",
        textSignature: "opaque-text-replay-payload",
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "src/a.ts" },
        thoughtSignature: "opaque-tool-replay-payload",
      },
    ]);
    message.diagnostics = [
      {
        type: "warning",
        timestamp: 3,
        error: { message: "local diagnostic" },
      },
    ];
    const result = build([
      message,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "complete file contents" }],
        details: { duplicatedLocalPayload: "must not be sent" },
        isError: true,
        timestamp: 3,
      },
    ]);

    const serialized = result.text;
    expect(serialized).toContain("inspect the boundary");
    expect(serialized).toContain("complete file contents");
    expect(serialized).toContain('"isError":true');
    expect(serialized).not.toContain("opaque-");
    expect(serialized).not.toContain("local diagnostic");
    expect(serialized).not.toContain("duplicatedLocalPayload");
    expect(serialized).not.toContain('"timestamp"');
    expect(serialized).not.toContain('"usage"');
    expect(serialized).not.toContain('"provider"');
  });

  test("pins the first user task and newest tail when the real model window is exceeded", () => {
    const messages: Message[] = [
      { role: "user", content: "TASK DEFINING REQUEST", timestamp: 1 },
      { role: "user", content: `old-1 ${"x".repeat(5_000)}`, timestamp: 2 },
      { role: "user", content: `old-2 ${"y".repeat(5_000)}`, timestamp: 3 },
      { role: "user", content: "NEWEST CONTEXT", timestamp: 4 },
    ];
    const result = buildAdvisorContext({
      context: { systemPrompt: "SYS", tools: [], messages },
      contextWindowTokens: 2_000,
      reservedOutputTokens: 100,
    });
    const parsed = payload(result.text);

    expect(parsed.executorContext.messages).toEqual([
      { role: "user", content: "TASK DEFINING REQUEST" },
      { role: "user", content: "NEWEST CONTEXT" },
    ]);
    expect(parsed.truncation.omittedMessages).toBe(2);
    expect(result.metadata).toMatchObject({
      includedMessages: 2,
      omittedMessages: 2,
      truncated: true,
    });
    expect(result.metadata.estimatedInputTokens).toBeLessThanOrEqual(
      2_000 - 100 - result.metadata.safetyMarginTokens,
    );
  });

  test("reserves framing headroom and charges multibyte text conservatively", () => {
    const result = buildAdvisorContext({
      context: {
        systemPrompt: "SYS",
        tools: [],
        messages: [
          { role: "user", content: "TASK", timestamp: 1 },
          { role: "user", content: "界".repeat(800), timestamp: 2 },
          { role: "user", content: "LATEST", timestamp: 3 },
        ],
      },
      contextWindowTokens: 1_000,
      reservedOutputTokens: 100,
    });

    expect(result.metadata.safetyMarginTokens).toBe(20);
    expect(result.metadata.truncated).toBe(true);
    expect(payload(result.text).executorContext.messages).toEqual([
      { role: "user", content: "TASK" },
      { role: "user", content: "LATEST" },
    ]);
  });

  test("forwards image blocks as multimodal attachments instead of base64 prompt text", () => {
    const image = { type: "image" as const, data: "BASE64_IMAGE_BYTES", mimeType: "image/png" };
    const result = build([
      { role: "user", content: [{ type: "text", text: "Inspect this." }, image], timestamp: 1 },
    ]);
    const parsed = payload(result.text);

    expect(result.images).toEqual([image]);
    expect(result.text).not.toContain("BASE64_IMAGE_BYTES");
    expect(parsed.executorContext.messages[0]).toMatchObject({
      content: [
        { type: "text", text: "Inspect this." },
        { type: "image", mimeType: "image/png", attachmentIndex: 0 },
      ],
    });
    expect(result.metadata.attachedImages).toBe(1);
  });

  test("fails clearly when pinned context alone cannot fit", () => {
    expect(() =>
      buildAdvisorContext({
        context: {
          systemPrompt: "SYS",
          tools: [],
          messages: [{ role: "user", content: `essential ${"x".repeat(2_000)}`, timestamp: 1 }],
        },
        contextWindowTokens: 200,
        reservedOutputTokens: 100,
      }),
    ).toThrow("too small");
  });
});
