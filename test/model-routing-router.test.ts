import { describe, expect, test } from "bun:test";
import type { ClassifierDecision, ClassifierInput } from "../src/model-routing/classifier.js";
import { ModelRouter, type RouteClassifier } from "../src/model-routing/router.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

const catalog = {
  modelAcceptsImages: (name: string) => name === "kimi-k3" || name === "gpt-5.6-luna",
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

  test("reroute nudge grants exactly one advisor-floor exemption when delivered", async () => {
    const router = createRouter(scriptedClassifier([plan]));
    const switched = await router.prepareTurn({});
    expect(switched?.toModel).toBe("fable-5");
    expect(router.beginAdvisorConsult().allowed).toBe(true);
    router.endAdvisorConsult(true);
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 5 });

    expect(router.takeRerouteNudge()).toContain(
      "changed from gpt-5.6-sol to fable-5 for the plan route",
    );
    expect(router.advisorGate()).toEqual({ allowed: false, stepsUntilAllowed: 5 });
    expect(router.beginAdvisorConsult()).toEqual({ allowed: true, stepsUntilAllowed: 0 });
    router.endAdvisorConsult(false);
    expect(router.beginAdvisorConsult()).toEqual({ allowed: false, stepsUntilAllowed: 5 });
    expect(router.takeRerouteNudge()).toBeUndefined();
  });

  test("advisor-triggered switches do not create a nudge loop", async () => {
    const router = createRouter(scriptedClassifier([general, plan]));
    await router.prepareTurn({});
    expect(router.beginAdvisorConsult().allowed).toBe(true);
    router.endAdvisorConsult(true);

    expect((await router.prepareTurn({}))?.trigger).toBe("advisor");
    expect(router.takeRerouteNudge()).toBeUndefined();
    expect(router.beginAdvisorConsult()).toEqual({ allowed: false, stepsUntilAllowed: 5 });
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
      modelName: "fable-5",
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
    await router.prepareTurn({});

    router.noteAssistantStep({ blockTypes: ["image"], text: "read an image" });
    expect(router.status().facts).toEqual({ hasImages: true });
    await router.prepareTurn({});
    expect(inputs.at(-1)?.hasImages).toBe(true);

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
    expect(router.status().modelName).toBe("glm-5.2");

    router.noteAssistantStep({ blockTypes: ["toolCall", "image"], text: "opened shot.png" });
    const switched = await router.prepareTurn({});

    expect(switched).toMatchObject({
      trigger: "step_trigger",
      route: "implement-visual",
      fromModel: "glm-5.2",
      toModel: "gpt-5.6-luna",
    });
    expect(inputs.at(-1)?.hasImages).toBe(true);
  });
});
