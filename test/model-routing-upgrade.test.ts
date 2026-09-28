import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingTable } from "../src/model-routing/loader.js";
import { resolveRoute } from "../src/model-routing/resolve.js";
import { resolveModelName, routingCatalogAdapter } from "../src/model-resolution/resolver.js";
import { duetModels } from "../src/model-resolution/models.js";
import baseline from "./fixtures/model-refresh/managed-routing-baseline.json" with { type: "json" };
import { testIfDocker } from "./helpers/docker-only.js";

const baselineBytes = await readFile(
  new URL("./fixtures/model-refresh/managed-routing-baseline.json", import.meta.url),
  "utf8",
);

testIfDocker(
  "an updated agent loads the previous gateway's managed table and dispatches current models",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "routing-upgrade-"));
    const path = join(dir, ".duet", "models.json");
    try {
      await mkdir(join(dir, ".duet"));
      await writeFile(path, baselineBytes);
      const { table } = await loadRoutingTable({
        cwd: dir,
        homeDir: join(dir, "home"),
        catalogAdapter: routingCatalogAdapter,
      });
      const expected = JSON.parse(
        baselineBytes.replaceAll('"gpt-5.6-sol"', '"sol"').replaceAll('"opus-5"', '"opus"'),
      );
      expect(table).toEqual(expected);
      for (const [tier, id] of [
        ["openai-max", "openai/gpt-6-sol"],
        ["anthropic-max", "anthropic/claude-opus-5.5"],
      ]) {
        const selected = resolveRoute(
          table,
          tier!,
          "general",
          { hasImages: false },
          routingCatalogAdapter,
        );
        expect(selected).toMatchObject({
          tier,
          route: "general",
          thinkingLevel: "medium",
          visionFallback: false,
          chain: [tier],
        });
        const model = resolveModelName(`duet-gateway:${selected.modelName}`);
        let payload: Record<string, unknown> | undefined;
        const stream = duetModels().streamSimple(
          model,
          { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
          {
            apiKey: "controlled-key",
            reasoning: selected.thinkingLevel,
            onPayload: (sent) => {
              payload = sent as Record<string, unknown>;
            },
            fetch: (async () => new Response("", { status: 400 })) as never,
          },
        );
        for await (const event of await stream) void event;
        expect(payload?.model).toBe(id);
        expect(table.tiers[tier!]!.advisor).toEqual({
          ...baseline.tiers[tier as "openai-max" | "anthropic-max"].advisor,
          target: { modelName: selected.modelName, thinkingLevel: "medium" },
        });
      }
      expect(await readFile(path, "utf8")).toBe(baselineBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "saved classifier and vision targets advance without changing virtual routing policy",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "routing-policy-"));
    const path = join(dir, ".duet", "models.json");
    const original = structuredClone(
      baseline,
    ) as import("../src/model-routing/table.js").RoutingTable;
    original.classifier.target = { modelName: "gpt-5.6-luna", thinkingLevel: "low" };
    original.tiers["openai-max"]!.routes.general!.target = {
      modelName: "opus-4.7",
      thinkingLevel: "high",
    };
    original.tiers["opus-4.7"] = {
      routes: {
        general: {
          description: "Custom chain with image fallback",
          target: { modelName: "glm-5.2", thinkingLevel: "low" },
          visionFallbackModelName: "opus-4.8",
        },
      },
      advisor: {
        enabled: true,
        target: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
        minStepsBetween: 7,
      },
    };
    const bytes = JSON.stringify(original);
    try {
      await mkdir(join(dir, ".duet"));
      await writeFile(path, bytes);
      const { table } = await loadRoutingTable({
        cwd: dir,
        homeDir: join(dir, "home"),
        catalogAdapter: routingCatalogAdapter,
      });
      expect(table.classifier).toEqual({
        ...original.classifier,
        target: { modelName: "luna", thinkingLevel: "low" },
      });
      expect(table.tiers["openai-max"]!.routes.general).toEqual(
        original.tiers["openai-max"]!.routes.general,
      );
      expect(table.tiers["opus-4.7"]!.advisor).toEqual({
        ...original.tiers["opus-4.7"]!.advisor,
        target: { modelName: "sol", thinkingLevel: "high" },
      });
      expect(
        resolveRoute(table, "openai-max", "general", { hasImages: false }, routingCatalogAdapter),
      ).toEqual({
        tier: "opus-4.7",
        route: "general",
        modelName: "glm",
        thinkingLevel: "low",
        visionFallback: false,
        chain: ["openai-max", "opus-4.7"],
      });
      expect(
        resolveRoute(table, "openai-max", "general", { hasImages: true }, routingCatalogAdapter),
      ).toEqual({
        tier: "opus-4.7",
        route: "general",
        modelName: "opus",
        thinkingLevel: "low",
        visionFallback: true,
        chain: ["openai-max", "opus-4.7"],
      });
      expect(await readFile(path, "utf8")).toBe(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

testIfDocker(
  "custom classifier selectors survive loading and unknown route targets still fail",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "routing-unknown-"));
    const path = join(dir, ".duet", "models.json");
    const original = structuredClone(baseline);
    original.classifier.target.modelName = "custom-provider/custom-evaluator";
    try {
      await mkdir(join(dir, ".duet"));
      await writeFile(path, JSON.stringify(original));
      const { table } = await loadRoutingTable({
        cwd: dir,
        homeDir: join(dir, "home"),
        catalogAdapter: routingCatalogAdapter,
      });
      expect(table.classifier.target).toEqual(original.classifier.target);
      original.tiers["openai-max"].routes.general.target.modelName = "unknown-user-model";
      const bytes = JSON.stringify(original);
      await writeFile(path, bytes);
      await expect(
        loadRoutingTable({
          cwd: dir,
          homeDir: join(dir, "home"),
          catalogAdapter: routingCatalogAdapter,
        }),
      ).rejects.toThrow(
        'Target "unknown-user-model" is neither a virtual model nor a catalog name.',
      );
      expect(await readFile(path, "utf8")).toBe(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
