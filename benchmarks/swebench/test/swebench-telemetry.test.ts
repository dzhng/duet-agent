import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deriveTelemetry, normalizePersistedTelemetry } from "../src/telemetry.js";
import type { TurnEvent } from "../../../src/types/protocol.js";

const FIXTURES = join(import.meta.dir, "../fixtures");

async function loadFixture(name: string): Promise<TurnEvent[]> {
  const text = await Bun.file(join(FIXTURES, name)).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

describe("SWE-bench telemetry derivation", () => {
  test("uses the terminal cumulative ledger for exact total and per-model cost", async () => {
    const telemetry = deriveTelemetry(await loadFixture("economy-rpc.sanitized.ndjson"));

    expect(telemetry.costUsdTotal).toBe(0.006905);
    expect(telemetry.costUsdByModel).toEqual({ "openai/gpt-5.6-luna": 0.006905 });
    expect(Object.values(telemetry.costUsdByModel).reduce((sum, cost) => sum + cost, 0)).toBe(
      telemetry.costUsdTotal,
    );
    expect(telemetry.tokens).toEqual({
      input: 6635,
      output: 45,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6680,
    });
    expect(telemetry.terminalStatus).toBe("completed");
  });

  test("counts Kimi and Fable advisor outcomes from generic tool details", async () => {
    const kimi = deriveTelemetry(await loadFixture("kimi-advisor.ndjson"));
    expect(kimi.advisorCalls).toEqual({
      total: 3,
      success: 1,
      rateLimited: 1,
      unavailable: 1,
      failed: 0,
      successByModel: { "moonshotai/kimi-k3": 1 },
      firstExplicitRepositoryMutationStep: null,
      attempts: [
        {
          step: 2,
          outcome: "success",
          model: "moonshotai/kimi-k3",
          contextStatus: "missing",
          relativeToFirstExplicitRepositoryMutation: "unknown",
        },
        {
          step: 3,
          outcome: "rate_limited",
          contextStatus: "missing",
          relativeToFirstExplicitRepositoryMutation: "unknown",
        },
        {
          step: 4,
          outcome: "unavailable",
          contextStatus: "missing",
          relativeToFirstExplicitRepositoryMutation: "unknown",
        },
      ],
    });

    const fable = deriveTelemetry(await loadFixture("fable-advisor.ndjson"));
    expect(fable.advisorCalls).toEqual({
      total: 1,
      success: 1,
      rateLimited: 0,
      unavailable: 0,
      failed: 0,
      successByModel: { "anthropic/claude-fable-5": 1 },
      firstExplicitRepositoryMutationStep: null,
      attempts: [
        {
          step: 1,
          outcome: "success",
          model: "anthropic/claude-fable-5",
          contextStatus: "missing",
          relativeToFirstExplicitRepositoryMutation: "unknown",
        },
      ],
    });
  });

  test("records each consultation attempt at its canonical step relative to explicit edits", () => {
    const events = [
      { type: "step", step: { type: "reasoning", text: "inspect" } },
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "ask_advisor",
          toolCallId: "a1",
          isError: false,
          details: {
            type: "ask_advisor",
            model: "moonshotai/kimi-k3",
            context: {
              contextWindowTokens: 262144,
              reservedOutputTokens: 2048,
              safetyMarginTokens: 5200,
              inputLimitTokens: 259000,
              inputTargetTokens: 32000,
              estimatedInputTokens: 12000,
              includedMessages: 8,
              compactedMessages: 6,
              omittedMessages: 2,
              truncated: true,
              attachedImages: 1,
            },
          },
        },
      },
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "edit",
          toolCallId: "e1",
          input: { path: "/testbed/src/main.ts" },
          isError: false,
        },
      },
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "ask_advisor",
          toolCallId: "a2",
          isError: false,
          details: { type: "ask_advisor", rateLimited: true },
        },
      },
    ] as TurnEvent[];

    expect(deriveTelemetry(events).advisorCalls).toEqual({
      total: 2,
      success: 1,
      rateLimited: 1,
      unavailable: 0,
      failed: 0,
      successByModel: { "moonshotai/kimi-k3": 1 },
      firstExplicitRepositoryMutationStep: 3,
      attempts: [
        {
          step: 2,
          outcome: "success",
          model: "moonshotai/kimi-k3",
          contextStatus: "valid",
          context: {
            contextWindowTokens: 262144,
            reservedOutputTokens: 2048,
            safetyMarginTokens: 5200,
            inputLimitTokens: 259000,
            inputTargetTokens: 32000,
            estimatedInputTokens: 12000,
            includedMessages: 8,
            compactedMessages: 6,
            omittedMessages: 2,
            truncated: true,
            attachedImages: 1,
          },
          relativeToFirstExplicitRepositoryMutation: "before",
        },
        {
          step: 4,
          outcome: "rate_limited",
          contextStatus: "missing",
          relativeToFirstExplicitRepositoryMutation: "after",
        },
      ],
    });
  });

  test("marks incomplete advisor context metadata malformed instead of treating it as fidelity proof", () => {
    const telemetry = deriveTelemetry([
      {
        type: "step",
        step: {
          type: "tool_call",
          toolName: "ask_advisor",
          toolCallId: "a1",
          isError: false,
          details: {
            type: "ask_advisor",
            model: "moonshotai/kimi-k3",
            context: { contextWindowTokens: 262144, truncated: false },
          },
        },
      },
    ] as TurnEvent[]);

    expect(telemetry.advisorCalls.attempts[0]).toEqual(
      expect.objectContaining({ outcome: "success", contextStatus: "malformed" }),
    );
    expect(telemetry.advisorCalls.attempts[0]).not.toHaveProperty("context");
  });

  test("migrates schema-v2 context evidence without inventing a safety margin", () => {
    const persisted = structuredClone(
      deriveTelemetry([
        {
          type: "step",
          step: {
            type: "tool_call",
            toolName: "ask_advisor",
            toolCallId: "a1",
            isError: false,
            details: {
              type: "ask_advisor",
              model: "moonshotai/kimi-k3",
              context: {
                contextWindowTokens: 262144,
                reservedOutputTokens: 2048,
                safetyMarginTokens: 5200,
                inputLimitTokens: 259000,
                estimatedInputTokens: 12000,
                includedMessages: 8,
                omittedMessages: 2,
                truncated: true,
                attachedImages: 1,
              },
            },
          },
        },
      ] as TurnEvent[]),
    ) as unknown as {
      schemaVersion: number;
      advisorCalls: {
        attempts: Array<{ contextStatus: string; context?: Record<string, unknown> }>;
      };
    };
    persisted.schemaVersion = 2;
    const contextualAttempt = persisted.advisorCalls.attempts.find((attempt) => attempt.context);
    expect(contextualAttempt).toBeDefined();
    delete contextualAttempt!.context!.safetyMarginTokens;

    const telemetry = normalizePersistedTelemetry(persisted);

    expect(telemetry.schemaVersion).toBe(3);
    expect(
      telemetry.advisorCalls.attempts.find((attempt) => attempt.outcome === "success"),
    ).toEqual(expect.objectContaining({ outcome: "success", contextStatus: "malformed" }));
    expect(
      telemetry.advisorCalls.attempts.find((attempt) => attempt.outcome === "success"),
    ).not.toHaveProperty("context");
  });

  test("builds switch histograms, excludes deltas and child steps, and tolerates new events", async () => {
    const events = await loadFixture("kimi-advisor.ndjson");
    events.push({ type: "future_protocol_event", payload: true } as unknown as TurnEvent);
    const telemetry = deriveTelemetry(events);

    expect(telemetry.routerSwitches).toEqual({
      "zai/glm-5.2→moonshotai/kimi-k3": 2,
      "moonshotai/kimi-k3→zai/glm-5.2": 1,
    });
    expect(telemetry.steps).toBe(4);
  });
});
