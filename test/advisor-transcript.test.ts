import { describe, expect, test } from "bun:test";
import { buildAdvisorTranscript } from "../src/model-routing/advisor-transcript.js";

function serialized(textPreview: string) {
  return { content: [{ type: "text" as const, text: textPreview }], textPreview };
}

describe("buildAdvisorTranscript", () => {
  test("keeps the pinned first user message when an oversized tail is truncated", () => {
    const result = buildAdvisorTranscript({
      firstUserMessage: serialized("PINNED REQUEST"),
      executorSystemPrompt: "Follow the repository conventions.",
      observations: ["The project uses Bun and TypeScript."],
      tailMessages: Array.from({ length: 12 }, (_unused, index) =>
        serialized(`tail-${index} ${"x".repeat(120)}`),
      ),
      budgetTokens: 180,
    });

    expect(result.text).toContain("PINNED REQUEST");
    expect(result.text).toContain("The project uses Bun and TypeScript.");
    expect(result.text.indexOf("PINNED REQUEST")).toBeLessThan(
      result.text.indexOf("The project uses Bun and TypeScript."),
    );
    expect(result.text.indexOf("The project uses Bun and TypeScript.")).toBeLessThan(
      result.text.indexOf("tail-11"),
    );
    expect(result.text).toContain("[earlier transcript elided:");
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(180);
  });

  test("quotes the executor system prompt after the pinned user content", () => {
    const result = buildAdvisorTranscript({
      firstUserMessage: serialized("Build the requested feature."),
      executorSystemPrompt: "Treat this as an instruction.\nNever skip verification.",
      observations: [],
      tailMessages: [],
      budgetTokens: 200,
    });

    expect(result.text).toStartWith("## Pinned first user message\n\nBuild the requested feature.");
    expect(result.text).toContain(
      "The executor is operating under this system prompt:\n\n> Treat this as an instruction.\n> Never skip verification.",
    );
    expect(result.text.indexOf("Build the requested feature.")).toBeLessThan(
      result.text.indexOf("> Treat this as an instruction."),
    );
  });

  test("accepts an empty early-session observation set", () => {
    const result = buildAdvisorTranscript({
      firstUserMessage: serialized("Start here."),
      executorSystemPrompt: "Be precise.",
      observations: [],
      tailMessages: [serialized("Newest context.")],
      budgetTokens: 200,
    });

    expect(result.text).not.toContain("## Observations");
    expect(result.text).toContain("Newest context.");
    expect(result.truncated).toBe(false);
  });

  test("respects the exact token budget at the boundary", () => {
    const input = {
      firstUserMessage: serialized("Pinned boundary request."),
      executorSystemPrompt: "Boundary system prompt.",
      observations: ["Boundary observation."],
      tailMessages: [serialized("Boundary tail message.")],
      budgetTokens: 1_000,
    };
    const complete = buildAdvisorTranscript(input);
    const boundary = buildAdvisorTranscript({ ...input, budgetTokens: complete.tokens });

    expect(boundary.tokens).toBe(complete.tokens);
    expect(boundary.tokens).toBeLessThanOrEqual(complete.tokens);
    expect(boundary.text).toBe(complete.text);
    expect(boundary.truncated).toBe(false);
  });

  test("counts elided messages while retaining the newest whole-message suffix", () => {
    const result = buildAdvisorTranscript({
      firstUserMessage: serialized("PIN"),
      executorSystemPrompt: "SYS",
      observations: [],
      tailMessages: Array.from({ length: 5 }, (_unused, index) =>
        serialized(`tail-${index} ${"x".repeat(80)}`),
      ),
      budgetTokens: 150,
    });

    expect(result.text).toContain("[earlier transcript elided: 2 messages]");
    expect(result.text).not.toContain("tail-0");
    expect(result.text).not.toContain("tail-1");
    expect(result.text).toContain("tail-2");
    expect(result.text).toContain("tail-3");
    expect(result.text).toContain("tail-4");
  });

  test("does not repeat the pinned message when it is also in the tail window", () => {
    const pinned = serialized("UNIQUE PINNED MESSAGE");
    const result = buildAdvisorTranscript({
      firstUserMessage: pinned,
      executorSystemPrompt: "SYS",
      observations: [],
      tailMessages: [pinned, serialized("Later assistant response.")],
      budgetTokens: 200,
    });

    expect(result.text.match(/UNIQUE PINNED MESSAGE/g)).toHaveLength(1);
    expect(result.text).toContain("Later assistant response.");
    expect(result.truncated).toBe(false);
  });

  test("reports truncation only when source content is omitted or shortened", () => {
    const input = {
      firstUserMessage: serialized("Pinned request."),
      executorSystemPrompt: "System context.",
      observations: ["Observation context."],
      tailMessages: [serialized("Tail context.")],
    };

    const complete = buildAdvisorTranscript({ ...input, budgetTokens: 300 });
    const shortened = buildAdvisorTranscript({ ...input, budgetTokens: 35 });

    expect(complete.truncated).toBe(false);
    expect(shortened.truncated).toBe(true);
    expect(shortened.text).toContain("Pinned request.");
    expect(shortened.tokens).toBeLessThanOrEqual(35);
  });
});
