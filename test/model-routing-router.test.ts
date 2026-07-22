import { describe, expect, test } from "bun:test";
import type { ClassifierDecision, ClassifierInput } from "../src/model-routing/classifier.js";
import { ModelRouter, type RouteClassifier } from "../src/model-routing/router.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

const catalog = {
  modelAcceptsImages: (name: string) => name !== "glm" && name !== "glm-5.2",
};

function scriptedClassifier(
  decisions: Array<ClassifierDecision | Error>,
  inputs: ClassifierInput[] = [],
): RouteClassifier {
  return async (input) => {
    inputs.push(input);
    const decision = decisions.shift();
    if (!decision) throw new Error("No scripted classifier decision");
    if (decision instanceof Error) throw decision;
    return decision;
  };
}

function createRouter(classify: RouteClassifier): ModelRouter {
  const router = new ModelRouter({
    table: BUILT_IN_ROUTING_TABLE,
    tier: "frontier",
    classify,
    resolveCatalog: catalog,
  });
  router.initialTarget({ hasImages: false });
  return router;
}

const general = { route: "general", rationale: "Continue general work." };
const implement = { route: "implement", rationale: "Implementation now dominates." };
const plan = { route: "plan", rationale: "The next phase is architectural planning." };

describe("ModelRouter", () => {
  test("cadence fires at five completed assistant steps, not four", async () => {
    const inputs: ClassifierInput[] = [];
    const router = createRouter(scriptedClassifier([general, implement], inputs));

    await router.prepareTurn({});
    for (let step = 0; step < 4; step++) {
      router.noteAssistantStep({ blockTypes: [], text: `step ${step + 1}` });
    }
    expect(router.shouldClassify()).toBe(false);
    expect(await router.prepareTurn({})).toBeUndefined();

    router.noteAssistantStep({ blockTypes: [], text: "step 5" });
    expect(router.shouldClassify()).toBe(true);
    expect((await router.prepareTurn({}))?.trigger).toBe("cadence");
    expect(inputs.map((input) => input.trigger)).toEqual(["turn_start", "cadence"]);
  });

  test("a successful advisor consult forces an early classification", async () => {
    const inputs: ClassifierInput[] = [];
    const router = createRouter(scriptedClassifier([general, plan], inputs));
    await router.prepareTurn({});
    router.noteAssistantStep({ blockTypes: [], text: "one step" });
    expect(router.beginAdvisorConsult().allowed).toBe(true);
    router.endAdvisorConsult(true);

    expect(router.shouldClassify()).toBe(true);
    expect((await router.prepareTurn({}))?.trigger).toBe("advisor");
    expect(inputs.at(-1)?.trigger).toBe("advisor");
  });

  test("pin suspends due classification and unpin resumes it", async () => {
    const router = createRouter(scriptedClassifier([general, implement]));
    await router.prepareTurn({});
    for (let step = 0; step < 5; step++) router.noteAssistantStep();
    router.pin();

    expect(router.shouldClassify()).toBe(false);
    expect(await router.prepareTurn({})).toBeUndefined();
    router.unpin();
    expect(router.shouldClassify()).toBe(true);
    expect(await router.prepareTurn({})).toBeDefined();
  });

  test("throwing classifier returns undefined and leaves state intact", async () => {
    const router = createRouter(scriptedClassifier([new Error("classifier down"), general]));
    const before = router.status();

    expect(await router.prepareTurn({})).toBeUndefined();
    expect(router.status()).toEqual(before);
    expect(router.shouldClassify()).toBe(true);
    expect(await router.prepareTurn({})).toBeUndefined();
    expect(router.shouldClassify()).toBe(false);
  });

  test("aborted classifier returns undefined and leaves state intact", async () => {
    const controller = new AbortController();
    const classify: RouteClassifier = async () => {
      controller.abort();
      throw controller.signal.reason;
    };
    const router = createRouter(classify);
    const before = router.status();

    expect(await router.prepareTurn({ signal: controller.signal })).toBeUndefined();
    expect(router.status()).toEqual(before);
    expect(router.shouldClassify()).toBe(true);
  });

  test("a route switch resets the advisor floor for the replacement model", async () => {
    const router = createRouter(scriptedClassifier([general, plan]));
    await router.prepareTurn({});
    expect(router.beginAdvisorConsult().allowed).toBe(true);
    router.endAdvisorConsult(true);
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 5 });

    expect((await router.prepareTurn({}))?.trigger).toBe("advisor");
    expect(router.beginAdvisorConsult()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    router.endAdvisorConsult(true);
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 5 });
  });

  test("advisor floor counts completed steps rather than advisor calls", () => {
    const router = createRouter(scriptedClassifier([general]));
    expect(router.advisorGate()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    expect(router.beginAdvisorConsult().allowed).toBe(true);
    router.endAdvisorConsult(true);
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 5 });
    for (let step = 0; step < 4; step++) router.noteAssistantStep();
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 1 });
    router.noteAssistantStep();
    expect(router.advisorGate()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
  });

  test("only one concurrent advisor consult can reserve the gate", () => {
    const router = createRouter(scriptedClassifier([general]));

    expect(router.beginAdvisorConsult()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    expect(router.beginAdvisorConsult()).toEqual({
      allowed: false,
      stepsUntilAllowed: 0,
      inFlight: true,
    });
    router.endAdvisorConsult(false);
    expect(router.advisorGate()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    expect(router.beginAdvisorConsult()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
  });

  test("status reports the complete inspector snapshot", async () => {
    const router = createRouter(scriptedClassifier([plan]));
    await router.prepareTurn({});
    router.noteAssistantStep({ blockTypes: [], text: "planned the change" });

    expect(router.status()).toEqual({
      tier: "frontier",
      route: "plan",
      modelName: "fable",
      thinkingLevel: "high",
      lastRationale: plan.rationale,
      assistantSteps: 1,
      stepsUntilClassification: 4,
      pinned: false,
      advisorEnabled: true,
      advisorGate: { allowed: true, stepsUntilAllowed: 0 },
      facts: { hasImages: false },
    });
  });

  test("image facts stay sticky within a turn and reset at the next prompt", async () => {
    const inputs: ClassifierInput[] = [];
    const router = createRouter(scriptedClassifier([general, general], inputs));
    router.noteTurnStart({ promptHasImages: false });
    await router.prepareTurn({ prevTurnHint: "Read the image, then implement the matching file." });

    router.noteAssistantStep({ blockTypes: ["image"], text: "read an image" });
    expect(router.status().facts).toEqual({ hasImages: true });
    await router.prepareTurn({});
    expect(inputs.at(-1)?.hasImages).toBe(true);
    expect(inputs.at(-1)?.prevTurnHint).toBe("Read the image, then implement the matching file.");

    router.noteTurnStart({ promptHasImages: false });
    expect(router.status().facts).toEqual({ hasImages: false });
  });

  test("a step trigger forces exactly the next classification boundary", async () => {
    const inputs: ClassifierInput[] = [];
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.stepTriggers = [{ name: "escalate", keywords: ["ESCALATE_ROUTE"] }];
    const configured = new ModelRouter({
      table,
      tier: "frontier",
      classify: scriptedClassifier([general, plan], inputs),
      resolveCatalog: catalog,
    });
    configured.initialTarget({ hasImages: false });
    configured.noteTurnStart({ promptHasImages: false });
    await configured.prepareTurn({});
    configured.noteAssistantStep({ blockTypes: [], text: "ordinary ESCALATE_ROUTE output" });

    expect(configured.shouldClassify()).toBe(true);
    expect((await configured.prepareTurn({}))?.trigger).toBe("step_trigger");
    expect(configured.shouldClassify()).toBe(false);
    expect(inputs.at(-1)?.trigger).toBe("step_trigger");
  });

  test("compaction arms exactly one cap-exempt classification with its own trigger", async () => {
    const inputs: ClassifierInput[] = [];
    const router = createRouter(scriptedClassifier([general, plan], inputs));
    await router.prepareTurn({});

    router.noteCompaction();
    expect(router.shouldClassify()).toBe(true);
    expect(await router.prepareTurn({})).toMatchObject({ trigger: "compaction", route: "plan" });
    expect(inputs.at(-1)?.trigger).toBe("compaction");
    expect(router.shouldClassify()).toBe(false);
  });

  test("compaction classification that keeps the target consumes the arm without a switch", async () => {
    const router = createRouter(scriptedClassifier([general, general]));
    await router.prepareTurn({});

    router.noteCompaction();
    expect(await router.prepareTurn({})).toBeUndefined();
    expect(router.shouldClassify()).toBe(false);
  });

  test("the next boundary redirects an image-bearing step away from a text-only target", async () => {
    const inputs: ClassifierInput[] = [];
    const router = new ModelRouter({
      table: BUILT_IN_ROUTING_TABLE,
      tier: "economy",
      classify: scriptedClassifier([implement, implement], inputs),
      resolveCatalog: catalog,
    });
    router.initialTarget({ hasImages: false });
    router.noteTurnStart({ promptHasImages: false });
    await router.prepareTurn({});
    expect(router.status().modelName).toBe("glm");

    router.noteAssistantStep({ blockTypes: ["toolCall", "image"], text: "opened shot.png" });
    const switched = await router.prepareTurn({});

    expect(switched).toMatchObject({
      trigger: "step_trigger",
      route: "implement",
      fromModel: "glm",
      toModel: "luna",
      visionFallback: true,
    });
    expect(inputs.at(-1)?.hasImages).toBe(true);
  });
});

test("a step trigger on the turn's final step survives into the next turn's classify", async () => {
  const inputs: ClassifierInput[] = [];
  const router = createRouter(scriptedClassifier([general, general], inputs));
  router.noteTurnStart({ promptHasImages: false });
  await router.prepareTurn({}); // consume the first-turn classification
  // Final step of the turn produces an image; no intra-turn boundary follows.
  router.noteAssistantStep({ blockTypes: ["image"], text: "" });
  // Next user turn begins; the arm must survive the fact reset.
  router.noteTurnStart({ promptHasImages: false });
  expect(router.shouldClassify()).toBe(true);
  await router.prepareTurn({});
  expect(inputs[1]?.trigger).toBe("step_trigger");
  expect(router.shouldClassify()).toBe(false);
});

describe("single-destination tiers", () => {
  function singleDestinationTable(): typeof BUILT_IN_ROUTING_TABLE {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "sol-only";
    table.tiers = {
      "sol-only": {
        routes: {
          general: {
            description: "All work on one model.",
            target: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
          },
        },
        advisor: structuredClone(BUILT_IN_ROUTING_TABLE.tiers.frontier!.advisor),
      },
    };
    return table;
  }

  test("never calls the classifier when every route resolves identically", async () => {
    const classify: RouteClassifier = async () => {
      throw new Error("classifier must not be called for a single-destination tier");
    };
    const router = new ModelRouter({
      table: singleDestinationTable(),
      tier: "sol-only",
      classify,
      resolveCatalog: catalog,
    });
    router.initialTarget({ hasImages: false });

    expect(router.shouldClassify()).toBe(false);
    router.noteTurnStart({ promptHasImages: false });
    // Step triggers, advisor milestones, and cadence all funnel through
    // shouldClassify, so none of them may wake the classifier either.
    router.noteAssistantStep({ blockTypes: ["image"], text: "" });
    router.beginAdvisorConsult();
    router.endAdvisorConsult(true);
    for (let step = 0; step < 6; step += 1) router.noteAssistantStep();
    expect(router.shouldClassify()).toBe(false);
    expect(await router.prepareTurn({})).toBeUndefined();
  });

  test("same model at different efforts is still a real decision", () => {
    const table = singleDestinationTable();
    table.tiers["sol-only"]!.routes.deep = {
      description: "Same model, deeper effort.",
      target: { modelName: "gpt-5.6-sol", thinkingLevel: "xhigh" },
    };
    const router = new ModelRouter({
      table,
      tier: "sol-only",
      classify: scriptedClassifier([general]),
      resolveCatalog: catalog,
    });
    router.initialTarget({ hasImages: false });
    expect(router.shouldClassify()).toBe(true);
  });

  test("an applied vision fallback with a different destination disables the optimization", () => {
    const table = singleDestinationTable();
    table.tiers["sol-only"]!.routes.general.target.modelName = "glm-5.2";
    table.tiers["sol-only"]!.routes.general.visionFallbackModelName = "gpt-5.6-luna";
    const router = new ModelRouter({
      table,
      tier: "sol-only",
      classify: scriptedClassifier([general]),
      resolveCatalog: catalog,
    });
    router.initialTarget({ hasImages: false });

    expect(router.shouldClassify()).toBe(true);
  });
});
