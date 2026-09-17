import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  buildClassifierMessages,
  buildClassifierRequest,
  classifierPath,
  classifyRoute,
  type ClassifierEvaluate,
  type ClassifierGenerate,
  type ClassifierInput,
  type ClassifierUsageReport,
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

const CHAT_USAGE: Usage = {
  input: 420,
  output: 24,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 444,
  cost: { input: 0.0004, output: 0.00014, cacheRead: 0, cacheWrite: 0, total: 0.00054 },
};

const CREDENTIAL_ENV = ["DUET_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"] as const;
const savedCredentials = Object.fromEntries(
  CREDENTIAL_ENV.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of CREDENTIAL_ENV) delete process.env[name];
});

afterEach(() => {
  for (const name of CREDENTIAL_ENV) {
    const value = savedCredentials[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function answering(
  choice: string,
  probabilities?: Record<string, number>,
  cost?: string,
): { evaluate: ClassifierEvaluate; calls: Parameters<ClassifierEvaluate>[0][] } {
  const calls: Parameters<ClassifierEvaluate>[0][] = [];
  return {
    calls,
    evaluate: async (call) => {
      calls.push(call);
      return {
        answers: { route: { type: "choice", choice, ...(probabilities ? { probabilities } : {}) } },
        usage: { inputTokens: 431, outputTokens: 3, totalTokens: 434 },
        providerMetadata: cost ? { gateway: { cost } } : undefined,
      };
    },
  };
}

function generating(
  route: string,
  rationale: string,
): { generate: ClassifierGenerate; calls: Parameters<ClassifierGenerate>[0][] } {
  const calls: Parameters<ClassifierGenerate>[0][] = [];
  const generate = (async (options: Parameters<ClassifierGenerate>[0]) => {
    calls.push(options);
    options.onUsage?.(CHAT_USAGE);
    return { route, rationale };
  }) as ClassifierGenerate;
  return { generate, calls };
}

describe("classifierPath", () => {
  test("sends catalog names to the chat classifier and everything else to evaluation", () => {
    expect(classifierPath({ modelName: "luna", thinkingLevel: "low" })).toBe("chat");
    expect(classifierPath({ modelName: "gpt-5.6-luna" })).toBe("chat");
    expect(classifierPath({ modelName: "typesafe-ai/jev" })).toBe("evaluation");
    expect(classifierPath(BUILT_IN_ROUTING_TABLE.classifier.target)).toBe("evaluation");
  });
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

describe("buildClassifierRequest", () => {
  test("asks one route choice over every tier route with policy, guidance, and cache framing", () => {
    const request = buildClassifierRequest(fixture);
    const question = request.questions.route;

    expect(Object.keys(request.questions)).toEqual(["route"]);
    expect(question.type).toBe("choice");
    expect(question.criteria).toEqual(
      Object.fromEntries(
        Object.entries(fixture.tier.routes).map(([name, rule]) => [name, rule.description]),
      ),
    );
    expect(question.instructions).toContain("Choose the single route");
    expect(question.instructions).toContain(fixture.guidance);
    expect(question.instructions).toContain(
      "The agent is currently on gpt-5.6-sol because route implement",
    );
    expect(question.instructions).toContain("discards the");
    expect(question.instructions).not.toMatch(/rationale|tool/i);
    expect(request.state).toEqual({
      trigger: "cadence",
      tier: "frontier",
      imagesPresent: true,
      currentTarget: "gpt-5.6-sol because route implement",
      previousTurnHint: fixture.prevTurnHint!,
      currentRequestOrLastStepDelta: fixture.lastStepDelta!,
    });
  });

  test("states there is no cache to preserve and marks absent hints as null", () => {
    const request = buildClassifierRequest({
      ...fixture,
      currentTarget: undefined,
      prevTurnHint: "  ",
      lastStepDelta: undefined,
      trigger: "turn_start",
    });

    expect(request.questions.route.instructions).toContain(
      "CURRENT TARGET: None (there is no prompt cache to preserve).",
    );
    expect(request.state).toMatchObject({
      currentTarget: null,
      previousTurnHint: null,
      currentRequestOrLastStepDelta: null,
    });
  });

  test("bounds previous-turn and last-step hints", () => {
    const request = buildClassifierRequest({
      ...fixture,
      prevTurnHint: "p".repeat(2_000),
      lastStepDelta: "d".repeat(2_000),
    });

    expect(request.state.previousTurnHint).toBe(`${"p".repeat(1_000)}…`);
    expect(request.state.currentRequestOrLastStepDelta).toBe(`${"d".repeat(1_000)}…`);
  });
});

describe("classifyRoute on a catalog target", () => {
  // No AI Gateway key anywhere: a catalog classifier resolves through the
  // metered router order like any other auxiliary actor, so a workspace whose
  // only credential is OpenRouter still classifies.
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  });

  test("forces the select_route tool at the configured effort and returns the rationale", async () => {
    const { generate, calls } = generating("implement", "The next step is implementation work.");
    const usage: ClassifierUsageReport[] = [];
    const controller = new AbortController();

    await expect(
      classifyRoute(fixture, {
        target: { modelName: "luna", thinkingLevel: "low" },
        generate,
        signal: controller.signal,
        onUsage: (report) => usage.push(report),
      }),
    ).resolves.toEqual({ route: "implement", rationale: "The next step is implementation work." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool.name).toBe("select_route");
    expect(calls[0]!.callOptions).toEqual({ reasoningEffort: "low" });
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.systemPrompt).toBe(buildClassifierMessages(fixture).systemPrompt);
    expect(calls[0]!.prompt).toBe(buildClassifierMessages(fixture).prompt);
    expect(calls[0]!.model).toContain("gpt-5.6-luna");
    // The attributed row must name exactly the provider:model the call used,
    // whichever metered provider the workspace credential resolved to.
    expect(usage).toHaveLength(1);
    expect(`${usage[0]!.transport}:${usage[0]!.modelId}`).toBe(calls[0]!.model);
    expect(usage[0]!.usage).toEqual(CHAT_USAGE);
  });

  test("omits reasoning effort when the target configures none", async () => {
    const { generate, calls } = generating("general", "Nothing more specific fits.");

    await expect(
      classifyRoute(fixture, { target: { modelName: "luna" }, generate }),
    ).resolves.toEqual({ route: "general", rationale: "Nothing more specific fits." });
    expect(calls[0]!.callOptions).toBeUndefined();
  });

  test("rejects an invented route name returned by the chat model", async () => {
    const { generate } = generating("invented", "This route does not exist.");

    await expect(
      classifyRoute(fixture, { target: { modelName: "luna", thinkingLevel: "low" }, generate }),
    ).rejects.toThrow('Classifier selected unknown route "invented" for tier "frontier".');
  });

  test("classifies without either AI Gateway credential", async () => {
    const { generate, calls } = generating("implement", "Implementation work.");

    expect(process.env.DUET_API_KEY).toBeUndefined();
    expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();
    await expect(
      classifyRoute(fixture, { target: { modelName: "luna" }, generate }),
    ).resolves.toMatchObject({ route: "implement" });
    expect(calls).toHaveLength(1);
  });
});

describe("classifyRoute on an evaluation target", () => {
  test("returns the chosen route with its distribution and reports gateway-priced usage", async () => {
    process.env.AI_GATEWAY_API_KEY = "vercel-test-key";
    const { evaluate, calls } = answering(
      "implement",
      { implement: 0.82, general: 0.12, plan: 0.06 },
      "0.000018102",
    );
    const usage: ClassifierUsageReport[] = [];
    const controller = new AbortController();

    await expect(
      classifyRoute(fixture, {
        target: { modelName: "typesafe-ai/jev" },
        evaluate,
        signal: controller.signal,
        onUsage: (report) => usage.push(report),
      }),
    ).resolves.toEqual({
      route: "implement",
      probabilities: { implement: 0.82, general: 0.12, plan: 0.06 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toMatchObject({ modelId: "typesafe-ai/jev" });
    expect(calls[0]!.abortSignal).toBe(controller.signal);
    expect(calls[0]!.state).toEqual(buildClassifierRequest(fixture).state);
    expect(calls[0]!.questions).toEqual(buildClassifierRequest(fixture).questions);
    expect(usage).toEqual([
      {
        modelId: "typesafe-ai/jev",
        transport: "vercel-ai-gateway",
        usage: {
          input: 431,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 434,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000018102 },
        },
      },
    ]);
  });

  test("attributes to the Duet gateway when its key is present and prices an unreported cost at zero", async () => {
    process.env.DUET_API_KEY = "duet-test-key";
    process.env.AI_GATEWAY_API_KEY = "vercel-test-key";
    const usage: ClassifierUsageReport[] = [];

    await expect(
      classifyRoute(fixture, {
        target: { modelName: "typesafe-ai/jev" },
        evaluate: answering("general").evaluate,
        onUsage: (report) => usage.push(report),
      }),
    ).resolves.toEqual({ route: "general" });
    expect(usage[0]).toMatchObject({ modelId: "typesafe-ai/jev", transport: "duet-gateway" });
    expect(usage[0]!.usage.cost.total).toBe(0);
  });

  test("rejects an invented route name returned by the evaluation model", async () => {
    process.env.DUET_API_KEY = "duet-test-key";

    await expect(
      classifyRoute(fixture, {
        target: { modelName: "typesafe-ai/jev" },
        evaluate: answering("invented").evaluate,
      }),
    ).rejects.toThrow('Classifier selected unknown route "invented" for tier "frontier".');
  });

  test("fails before any call when no gateway credential is configured", async () => {
    const { evaluate, calls } = answering("general");

    await expect(
      classifyRoute(fixture, { target: { modelName: "typesafe-ai/jev" }, evaluate }),
    ).rejects.toThrow("set DUET_API_KEY or AI_GATEWAY_API_KEY");
    expect(calls).toEqual([]);
  });
});
