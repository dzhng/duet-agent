import { describe, expect, test } from "bun:test";
import { streamSimple, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { resolveModelName } from "../src/model-resolution/resolver.js";

const openAiModel = process.env.EVAL_MODEL ?? "gpt-5.5";

describe("OpenAI thinking trace routing", () => {
  test("gpt-5.5 shorthand resolves to an OpenAI-compatible provider that can emit reasoning events", async () => {
    const model = resolveModelName(openAiModel);

    expect(model.reasoning).toBe(true);
    expect(model.api).not.toBe("anthropic-messages");
  });

  test("OpenAI-compatible GPT models request reasoning through the provider's OpenAI stream path", async () => {
    const model = resolveModelName(openAiModel);
    if (model.api !== "openai-completions" && model.api !== "openai-responses") {
      throw new Error(`Expected an OpenAI-compatible model; got ${model.provider}:${model.api}`);
    }

    const payload = await capturePayload(model, "high");
    expect(hasReasoningRequest(payload)).toBe(true);
  });
});

async function capturePayload(
  model: Model<any>,
  reasoning: "low" | "medium" | "high",
): Promise<unknown> {
  let captured: unknown;
  const stream = streamSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: "Reply with one short sentence.",
          timestamp: Date.now(),
        },
      ],
    },
    {
      reasoning,
      apiKey: "eval-key",
      onPayload: (payload) => {
        captured = payload;
        return abortingPayloadFor(model);
      },
    },
  );

  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    if (event.type === "error") break;
  }

  if (!captured) throw new Error("Expected provider payload to be captured");
  return captured;
}

function abortingPayloadFor(model: Model<any>): unknown {
  if (model.api === "openai-responses") {
    return {
      model: model.id,
      input: [],
      stream: true,
    };
  }
  return {
    model: model.id,
    messages: [],
    stream: true,
  };
}

function hasReasoningRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (typeof record.reasoning_effort === "string") return true;
  const reasoning = record.reasoning;
  if (!reasoning || typeof reasoning !== "object") return false;
  return typeof (reasoning as Record<string, unknown>).effort === "string";
}
