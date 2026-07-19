import { describe, expect } from "bun:test";
import type { ClassifierInput } from "../src/model-routing/classifier.js";
import { ModelRouter } from "../src/model-routing/router.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { settlementNotice } from "../src/turn-runner/task-tools.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const KEYWORD = "SETTLEMENT_ROUTE_SENTINEL_Q7";

describe("task settlement routing neutrality", () => {
  testIfDocker("ignores settlement plumbing but reroutes for genuine assistant text", async () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.everySteps = 99;
    table.classifier.stepTriggers = [{ name: "settlement", keywords: [KEYWORD] }];
    const inputs: ClassifierInput[] = [];
    const decisions = [
      { route: "general", rationale: "Initial route." },
      { route: "plan", rationale: "The genuine assistant text requests planning." },
    ];
    const router = new ModelRouter({
      table,
      tier: "frontier",
      resolveCatalog: { modelAcceptsImages: (name) => name !== "glm-5.2" },
      classify: async (input) => {
        inputs.push(input);
        const decision = decisions.shift();
        if (!decision) throw new Error("Unexpected classifier call");
        return decision;
      },
    });
    router.initialTarget({ hasImages: false });
    await router.prepareTurn({});

    const settlement = settlementNotice([
      {
        descriptor: {
          id: "t1",
          kind: "tool",
          name: "bash",
          label: KEYWORD,
          ownerScopeId: "root",
          status: "completed",
          startedAt: 1,
        },
        output: [],
        settlement: { id: "t1", status: "completed", settledAt: 2, result: "done" },
      },
    ]);
    router.noteAssistantStep({ blockTypes: ["text"], text: settlement });
    expect(await router.prepareTurn({})).toBeUndefined();
    expect(inputs.map(({ trigger }) => trigger)).toEqual(["turn_start"]);

    router.noteAssistantStep({
      blockTypes: ["text"],
      text: `Genuine assistant analysis: ${KEYWORD}`,
    });
    expect(await router.prepareTurn({})).toMatchObject({ trigger: "step_trigger", route: "plan" });
    expect(inputs.map(({ trigger }) => trigger)).toEqual(["turn_start", "step_trigger"]);

    // Falsification: pass the settlement builder's inner text without its synthetic sentinel.
    // The first prepareTurn then returns a step_trigger switch and the one-input assertion reds.
  });
});
