import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeDuetTier, setActiveDuetTier } from "../src/model-routing/active-tier.js";
import { callAdvisor } from "../src/model-routing/advisor.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { DUET_TIER_HEADER } from "../src/model-resolution/duet-gateway.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";

afterEach(() => setActiveDuetTier(undefined));

// Metered sessions always run with a gateway key; without it, catalog aliases
// fall back to BYOK transports and never reach the duet gateway at all.
const previousDuetApiKey = process.env.DUET_API_KEY;

beforeAll(() => {
  process.env.DUET_API_KEY = "tier-header-test-key";
});

afterAll(() => {
  if (previousDuetApiKey === undefined) delete process.env.DUET_API_KEY;
  else process.env.DUET_API_KEY = previousDuetApiKey;
});

/** Exposes the parent agent's resolved model — the spec outbound requests use. */
class TierProbeRunner extends TurnRunner {
  parentModelForTest() {
    return this.requireParentAgent().state.model;
  }
}

/**
 * Start a runner inside a temp cwd whose `.duet/models.json` defines a single
 * operator tier named `custom`. Writing a project table also shields the test
 * from any real `~/.duet/models.json` on the host (nearest file wins).
 */
async function withOperatorTableRunner(
  model: string,
  run: (runner: TierProbeRunner) => Promise<void> | void,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "duet-tier-header-"));
  try {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "custom";
    table.tiers = { custom: table.tiers.frontier! };
    await mkdir(join(cwd, ".duet"));
    await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
    const runner = new TierProbeRunner({
      model,
      mode: "agent",
      cwd,
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    try {
      await runner.start({ type: "start", mode: "agent" });
      await run(runner);
    } finally {
      await runner.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Run one advisor consultation against a capture-only fetch and return the
 * headers of its wire request. The stub 400s so the call always rejects;
 * attribution is judged on what reached the wire, not on the response.
 */
async function capturedAdvisorRequestHeaders(): Promise<Headers | undefined> {
  const originalFetch = globalThis.fetch;
  let captured: Headers | undefined;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      captured = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      return new Response(JSON.stringify({ error: { message: "capture-only fetch" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch;
  try {
    await expect(
      callAdvisor({
        contextText: "executor context",
        images: [],
        modelName: "anthropic/claude-fable-5.1",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow();
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("duet gateway tier attribution", () => {
  test("stamps the active tier on every duet-gateway model", () => {
    setActiveDuetTier("balanced");

    // One assertion per routing role that bills through the pi transport: the
    // parent step, the classifier, and the vision fallback all resolve through
    // this seam, so a per-role regression shows up here rather than in
    // production. The advisor bills through the AI SDK client instead and is
    // covered by its own consultation tests below.
    for (const modelId of [
      "anthropic/claude-fable-5.1",
      "openai/gpt-5.6-luna",
      "moonshotai/kimi-k3",
      "zai/glm-5.2",
    ]) {
      expect(resolveModelName(`duet-gateway:${modelId}`).headers?.[DUET_TIER_HEADER]).toBe(
        "balanced",
      );
    }
  });

  test("omits the header entirely when a concrete model is pinned", () => {
    setActiveDuetTier(undefined);

    const model = resolveModelName("duet-gateway:anthropic/claude-fable-5.1");

    expect(model.headers?.[DUET_TIER_HEADER]).toBeUndefined();
  });

  test("carries whatever tier name the routing table defines", () => {
    // Tier names come from a config-driven table, so the agent must attribute
    // a name it has never heard of rather than validating against a fixed set.
    setActiveDuetTier("some-operator-defined-tier");

    expect(resolveModelName("duet-gateway:openai/gpt-5.6-sol").headers?.[DUET_TIER_HEADER]).toBe(
      "some-operator-defined-tier",
    );
  });

  test("stamping is additive — the tiered model differs only by the header", () => {
    setActiveDuetTier(undefined);
    const bare = resolveModelName("duet-gateway:anthropic/claude-fable-5.1");

    setActiveDuetTier("frontier");
    const { headers, ...rest } = resolveModelName("duet-gateway:anthropic/claude-fable-5.1");

    expect(headers).toEqual({ [DUET_TIER_HEADER]: "frontier" });
    expect(rest).toEqual(bare);
  });

  test("leaves non-gateway transports unattributed", () => {
    setActiveDuetTier("frontier");

    // A vercel/openrouter pin is not Duet-metered traffic, so it must not claim
    // a Duet tier even while a routed session is active.
    expect(resolveModelName("vercel-ai-gateway:zai/glm-5.2").headers?.[DUET_TIER_HEADER]).toBe(
      undefined,
    );
  });

  test("start() attributes an operator-defined tier loaded from .duet/models.json", async () => {
    // The tier must be published against the *loaded* table, not the built-in
    // one — `custom` only exists in the project file, so a sync that runs
    // before the table loads clears the tier and this session's gateway
    // traffic goes out unattributed.
    await withOperatorTableRunner("custom", (runner) => {
      expect(runner.parentModelForTest().headers?.[DUET_TIER_HEADER]).toBe("custom");
      expect(activeDuetTier()).toBe("custom");
    });
  });

  test("start() leaves a concrete pin unattributed even with a project table present", async () => {
    await withOperatorTableRunner("gpt-5.6-sol", (runner) => {
      expect(runner.parentModelForTest().headers?.[DUET_TIER_HEADER]).toBeUndefined();
      expect(activeDuetTier()).toBeUndefined();
    });
  });

  test("a mid-session /model switch retargets attribution both ways", async () => {
    await withOperatorTableRunner("gpt-5.6-sol", (runner) => {
      expect(runner.setModel("custom")).toEqual({ routed: true });
      expect(runner.parentModelForTest().headers?.[DUET_TIER_HEADER]).toBe("custom");

      expect(runner.setModel("gpt-5.6-sol")).toEqual({ routed: false });
      expect(runner.parentModelForTest().headers?.[DUET_TIER_HEADER]).toBeUndefined();
      expect(activeDuetTier()).toBeUndefined();
    });
  });

  test("an advisor consultation claims the active tier on its gateway request", async () => {
    // The advisor bills through the AI SDK client rather than the pi transport,
    // so the pi-side model stamping never reaches its wire request. The duet
    // gateway 403s any unclaimed request for a non-internal model, which made
    // every consultation fail in production while the tool reported a soft
    // "consultation failed" result.
    setActiveDuetTier("balanced");

    const headers = await capturedAdvisorRequestHeaders();

    expect(headers?.get(DUET_TIER_HEADER)).toBe("balanced");
  });

  test("a concrete-pin advisor consultation stays unattributed", async () => {
    setActiveDuetTier(undefined);

    const headers = await capturedAdvisorRequestHeaders();

    // Null (header absent from a captured request) — not undefined, which
    // would mean the consultation never reached the wire at all.
    expect(headers?.get(DUET_TIER_HEADER)).toBeNull();
  });

  test("reports the active tier back to callers", () => {
    setActiveDuetTier("economy");
    expect(activeDuetTier()).toBe("economy");

    setActiveDuetTier(undefined);
    expect(activeDuetTier()).toBeUndefined();
  });
});
