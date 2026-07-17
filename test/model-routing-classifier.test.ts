import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as structuredOutput from "../src/core/structured-output.js";
import {
  buildClassifierMessages,
  classifyRoute,
  type ClassifierInput,
} from "../src/model-routing/classifier.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

const fixture: ClassifierInput = {
  tierName: "frontier",
  tier: BUILT_IN_ROUTING_TABLE.tiers.frontier,
  guidance: "Keep implementation work on the implementation route.",
  currentTarget: "gpt-5.6-sol because route implement",
  prevTurnHint: "The previous turn planned a settings-page redesign.",
  lastStepDelta: "The plan is complete; the next step is editing TypeScript.",
  hasImages: true,
  trigger: "cadence",
};

afterEach(() => {
  spyOn(structuredOutput, "generateStructuredOutput").mockRestore();
});

describe("buildClassifierMessages", () => {
  test("renders all rules, guidance, lean context, and cache preference", () => {
    const messages = buildClassifierMessages(fixture);

    expect(messages.systemPrompt).toContain("Choose the single route");
    expect(messages.systemPrompt).toContain("prompt cache");
    expect(messages.prompt).toContain("TIER: frontier");
    for (const [name, rule] of Object.entries(fixture.tier.routes)) {
      expect(messages.prompt).toContain(`- ${name}: ${rule.description}`);
    }
    expect(messages.prompt).toContain(fixture.guidance);
    expect(messages.prompt).toContain("Images present: yes");
    expect(messages.prompt).toContain("Trigger: cadence");
    expect(messages.prompt).toContain("gpt-5.6-sol because route implement");
    expect(messages.prompt).toContain("Switching away discards the current model's prompt cache");
    expect(messages.prompt).toContain(fixture.prevTurnHint!);
    expect(messages.prompt).toContain(fixture.lastStepDelta!);
  });

  test("bounds previous-turn and last-step hints", () => {
    const messages = buildClassifierMessages({
      ...fixture,
      prevTurnHint: "p".repeat(2_000),
      lastStepDelta: "d".repeat(2_000),
    });

    expect(messages.prompt).not.toContain("p".repeat(1_001));
    expect(messages.prompt).not.toContain("d".repeat(1_001));
    expect(messages.prompt).toContain(`${"p".repeat(1_000)}…`);
    expect(messages.prompt).toContain(`${"d".repeat(1_000)}…`);
  });
});

describe("classifyRoute", () => {
  test("rejects an invented route name returned by structured output", async () => {
    spyOn(structuredOutput, "generateStructuredOutput").mockResolvedValue({
      route: "invented",
      rationale: "This route does not exist.",
    });

    await expect(classifyRoute(fixture, { model: "gpt-5.6-luna" })).rejects.toThrow(
      'Classifier selected unknown route "invented" for tier "frontier".',
    );
  });

  test("requests low reasoning and returns an existing route", async () => {
    const generate = spyOn(structuredOutput, "generateStructuredOutput").mockResolvedValue({
      route: "implement",
      rationale: "The next step is implementation work.",
    });

    await expect(classifyRoute(fixture, { model: "gpt-5.6-luna" })).resolves.toEqual({
      route: "implement",
      rationale: "The next step is implementation work.",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].callOptions).toEqual({ reasoningEffort: "low" });
  });
});
