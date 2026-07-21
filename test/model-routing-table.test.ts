import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  BUILT_IN_ROUTING_TABLE,
  RoutingTableSchema,
  isVirtualModel,
  validateRoutingTable,
  virtualModelNames,
  type RoutingCatalogAdapter,
} from "../src/model-routing/table.js";
import { exportRoutingTable, loadRoutingTable } from "../src/model-routing/loader.js";
import { routingCatalogAdapter } from "../src/model-resolution/resolver.js";
import { testIfDocker } from "./helpers/docker-only.js";

const catalogNames = new Set([
  "kimi-k3",
  "fable-5",
  "gpt-5.6-sol",
  "opus-4.8",
  "gpt-5.6-terra",
  "sonnet-5",
  "gpt-5.6-luna",
  "glm-5.2",
]);
const catalog: RoutingCatalogAdapter = {
  isCatalogName: (name) => catalogNames.has(name),
  modelAcceptsImages: (name) => name !== "glm-5.2",
};

let tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs) await rm(tempDir, { recursive: true, force: true });
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "duet-model-routing-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("built-in model routing table", () => {
  test("encodes the final tier matrix and policies exactly", () => {
    const table = BUILT_IN_ROUTING_TABLE;

    const targets = (tier: "frontier" | "balanced" | "economy") =>
      Object.fromEntries(
        Object.entries(table.tiers[tier].routes).map(([route, rule]) => [route, rule.target]),
      );

    expect(table.defaultTier).toBe("frontier");
    expect(targets("frontier")).toEqual({
      visual: { modelName: "kimi-k3", thinkingLevel: "high" },
      plan: { modelName: "fable-5", thinkingLevel: "high" },
      implement: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
      writing: { modelName: "opus-4.8", thinkingLevel: "medium" },
      general: { modelName: "gpt-5.6-sol", thinkingLevel: "medium" },
    });
    expect(targets("balanced")).toEqual({
      visual: { modelName: "kimi-k3", thinkingLevel: "high" },
      plan: { modelName: "gpt-5.6-sol", thinkingLevel: "high" },
      implement: { modelName: "gpt-5.6-terra", thinkingLevel: "high" },
      writing: { modelName: "sonnet-5", thinkingLevel: "medium" },
      general: { modelName: "gpt-5.6-terra", thinkingLevel: "medium" },
    });
    expect(targets("economy")).toEqual({
      plan: { modelName: "gpt-5.6-luna", thinkingLevel: "medium" },
      implement: { modelName: "glm-5.2", thinkingLevel: "medium" },
      general: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
    });
    expect(table.tiers.economy.routes.implement.visionFallbackModelName).toBe("gpt-5.6-luna");

    expect(table.tiers.frontier.advisor).toEqual({
      enabled: true,
      target: { modelName: "fable-5", thinkingLevel: "high" },
      minStepsBetween: 5,
    });
    expect(table.tiers.balanced.advisor).toEqual(table.tiers.frontier.advisor);
    expect(table.tiers.economy.advisor).toEqual({
      enabled: false,
      target: { modelName: "gpt-5.6-terra", thinkingLevel: "medium" },
      minStepsBetween: 5,
    });
    expect(table.classifier).toEqual({
      target: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
      everySteps: 5,
      guidance:
        "Prefer continuity when the task has not materially changed, but switch routes when the work changes domains.",
    });
  });

  test("round-trips through JSON and the TypeBox schema", () => {
    const roundTripped = JSON.parse(JSON.stringify(BUILT_IN_ROUTING_TABLE));

    expect(Value.Check(RoutingTableSchema, roundTripped)).toBe(true);
    expect(roundTripped).toEqual(BUILT_IN_ROUTING_TABLE);
  });

  test("round-trips configured step-output triggers", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.stepTriggers = [
      { name: "escalate", keywords: ["ESCALATE_ROUTE", "needs specialist"] },
    ];
    const roundTripped = JSON.parse(JSON.stringify(table));

    expect(Value.Check(RoutingTableSchema, roundTripped)).toBe(true);
    expect(roundTripped.classifier.stepTriggers).toEqual(table.classifier.stepTriggers);
  });

  test("recognizes only table-owned virtual model names", () => {
    expect(virtualModelNames(BUILT_IN_ROUTING_TABLE)).toEqual(["frontier", "balanced", "economy"]);
    expect(isVirtualModel("frontier", BUILT_IN_ROUTING_TABLE)).toBe(true);
    expect(isVirtualModel("opus-4.8", BUILT_IN_ROUTING_TABLE)).toBe(false);
    expect(validateRoutingTable(BUILT_IN_ROUTING_TABLE, catalog)).toEqual([]);
  });

  test("only glm needs a built-in per-route vision fallback", () => {
    // Capability probe recorded with the product rationale for removing the vision route axis.
    for (const name of [
      "kimi-k3",
      "fable-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "opus-4.8",
      "sonnet-5",
    ]) {
      expect(routingCatalogAdapter.modelAcceptsImages(name), name).toBe(true);
    }
    expect(routingCatalogAdapter.modelAcceptsImages("glm-5.2")).toBe(false);
  });

  test("rejects a virtual tier that collides with a catalog shorthand", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers["opus-4.8"] = table.tiers.frontier;

    expect(validateRoutingTable(table, catalog)).toContainEqual({
      code: "catalog_collision",
      path: "tiers.opus-4.8",
      message: 'Virtual model "opus-4.8" collides with a concrete catalog shorthand or alias.',
    });
  });

  test("reports the complete path through a virtual cycle", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.frontier.routes.implement.target.modelName = "balanced";
    table.tiers.balanced.routes.implement.target.modelName = "economy";
    table.tiers.economy.routes.implement.target.modelName = "frontier";

    const cycles = validateRoutingTable(table, catalog).filter(
      (issue) => issue.code === "virtual_cycle",
    );

    expect(
      cycles.some((issue) => issue.message.includes("frontier -> balanced -> economy -> frontier")),
    ).toBe(true);
  });

  test("keeps classifier and advisor targets concrete even though routes may re-enter virtual tiers", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.target.modelName = "frontier";
    table.tiers.frontier.advisor.target.modelName = "balanced";

    const issues = validateRoutingTable(table, catalog);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dangling_reference",
          path: "classifier.target.modelName",
        }),
        expect.objectContaining({
          code: "dangling_reference",
          path: "tiers.frontier.advisor.target.modelName",
        }),
      ]),
    );
  });

  test("reports dangling refs, invalid efforts and cadences, and text-only vision fallbacks", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "missing";
    table.tiers.frontier.routes.plan.visionFallbackModelName = "glm-5.2";
    table.tiers.frontier.routes.plan.target.modelName = "missing-model";
    Reflect.set(table.tiers.frontier.routes.plan.target, "thinkingLevel", "extreme");
    table.tiers.frontier.advisor.minStepsBetween = 0;
    table.classifier.everySteps = -1;

    const issues = validateRoutingTable(table, catalog);

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "dangling_reference",
        "invalid_effort",
        "invalid_cadence",
        "invalid_vision_fallback_model",
      ]),
    );
    expect(
      issues.find((issue) => issue.code === "invalid_vision_fallback_model")?.message,
    ).toContain('text-only model "glm-5.2"');
  });

  test("reports a missing per-route vision fallback with its dedicated issue code", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes.implement.visionFallbackModelName = "missing-fallback";

    expect(validateRoutingTable(table, catalog)).toContainEqual({
      code: "invalid_vision_fallback_model",
      path: "tiers.economy.routes.implement.visionFallbackModelName",
      message: 'Vision fallback "missing-fallback" is neither a virtual model nor a catalog name.',
    });
  });

  test("reports cycles reached through a virtual vision fallback", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers.economy.routes.implement.visionFallbackModelName = "frontier";
    table.tiers.frontier.routes.implement.target.modelName = "balanced";
    table.tiers.balanced.routes.implement.target.modelName = "frontier";

    expect(validateRoutingTable(table, catalog)).toContainEqual({
      code: "invalid_vision_fallback_model",
      path: "tiers.economy.routes.implement.visionFallbackModelName",
      message: "Vision fallback cycle: frontier -> balanced -> frontier.",
    });
  });

  test("rejects duplicate or empty step-trigger names and empty keywords", () => {
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.stepTriggers = [
      { name: "", keywords: ["valid"] },
      { name: "duplicate", keywords: [] },
      { name: "duplicate", keywords: [""] },
    ];

    expect(validateRoutingTable(table, catalog)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_step_trigger_name" }),
        expect.objectContaining({ code: "duplicate_step_trigger_name" }),
        expect.objectContaining({ code: "invalid_step_trigger_keywords" }),
      ]),
    );
    expect(Value.Check(RoutingTableSchema, table)).toBe(false);
  });
});

describe("routing table file loading and export", () => {
  testIfDocker("uses the built-in table when the optional file is absent", async () => {
    const cwd = await makeTempDir();

    expect(
      await loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).toEqual({
      table: BUILT_IN_ROUTING_TABLE,
      source: "built-in",
    });
  });

  testIfDocker("loads the file as a complete replacement instead of merging tiers", async () => {
    const cwd = await makeTempDir();
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "custom";
    table.tiers = {
      custom: {
        routes: {
          general: {
            description: "All custom work.",
            target: { modelName: "gpt-5.6-luna", thinkingLevel: "low" },
          },
        },
        advisor: {
          enabled: false,
          target: { modelName: "gpt-5.6-terra", thinkingLevel: "medium" },
          minStepsBetween: 5,
        },
      },
    };
    await mkdir(join(cwd, ".duet"));
    const path = join(cwd, ".duet", "models.json");
    await writeFile(path, JSON.stringify(table));

    expect(
      await loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).toEqual({
      table,
      source: "file",
      path,
    });
  });

  testIfDocker("fails loudly for invalid JSON instead of falling back", async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, ".duet"));
    await writeFile(join(cwd, ".duet", "models.json"), "{invalid");

    await expect(
      loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).rejects.toThrow("Failed to parse routing table");
  });

  testIfDocker("enforces intrinsic validation with an explicit catalog adapter", async () => {
    const cwd = await makeTempDir();
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.classifier.everySteps = 0;
    await mkdir(join(cwd, ".duet"));
    await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));

    await expect(
      loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).rejects.toThrow("Classifier cadence must be a positive number of steps.");
  });

  testIfDocker("fails loading when a file tier collides with a catalog alias", async () => {
    const cwd = await makeTempDir();
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.tiers["opus-4.8"] = table.tiers.frontier;
    await mkdir(join(cwd, ".duet"));
    await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));

    await expect(
      loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).rejects.toThrow(
      'Virtual model "opus-4.8" collides with a concrete catalog shorthand or alias.',
    );
  });

  testIfDocker("exports deterministic JSON that loads back to the built-in table", async () => {
    const cwd = await makeTempDir();

    const result = await exportRoutingTable({ cwd, force: false });
    const expectedPath = join(cwd, ".duet", "models.json");
    expect(result).toEqual({ path: expectedPath, table: BUILT_IN_ROUTING_TABLE });
    expect(await readFile(expectedPath, "utf8")).toBe(
      `${JSON.stringify(BUILT_IN_ROUTING_TABLE, null, 2)}\n`,
    );
    expect(
      await loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: await makeTempDir() }),
    ).toEqual({
      table: BUILT_IN_ROUTING_TABLE,
      source: "file",
      path: expectedPath,
    });
  });

  testIfDocker("refuses to overwrite an exported table unless force is true", async () => {
    const cwd = await makeTempDir();
    await exportRoutingTable({ cwd, force: false });

    await expect(exportRoutingTable({ cwd, force: false })).rejects.toThrow(
      "Routing table already exists",
    );
    await expect(exportRoutingTable({ cwd, force: true })).resolves.toBeDefined();
  });
});

describe("routing table discovery walk", () => {
  testIfDocker("the nearest ancestor's table wins over one higher up", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const repo = join(root, "repo");
    const pkg = join(repo, "packages", "app");
    await mkdir(join(repo, ".duet"), { recursive: true });
    await mkdir(pkg, { recursive: true });

    const repoTable = structuredClone(BUILT_IN_ROUTING_TABLE);
    repoTable.classifier.guidance = "repo-level table";
    await writeFile(join(repo, ".duet", "models.json"), JSON.stringify(repoTable));

    const fromPkg = await loadRoutingTable({ cwd: pkg, catalogAdapter: catalog, homeDir: home });
    expect(fromPkg.source).toBe("file");
    expect(fromPkg.table.classifier.guidance).toBe("repo-level table");

    const pkgTable = structuredClone(BUILT_IN_ROUTING_TABLE);
    pkgTable.classifier.guidance = "package-level table";
    await mkdir(join(pkg, ".duet"), { recursive: true });
    await writeFile(join(pkg, ".duet", "models.json"), JSON.stringify(pkgTable));

    const nearest = await loadRoutingTable({ cwd: pkg, catalogAdapter: catalog, homeDir: home });
    expect(nearest.table.classifier.guidance).toBe("package-level table");
  });

  testIfDocker("falls back to ~/.duet/models.json when no ancestor has one", async () => {
    const cwd = await makeTempDir();
    const home = await makeTempDir();
    const homeTable = structuredClone(BUILT_IN_ROUTING_TABLE);
    homeTable.classifier.guidance = "home-level table";
    await mkdir(join(home, ".duet"), { recursive: true });
    await writeFile(join(home, ".duet", "models.json"), JSON.stringify(homeTable));

    const loaded = await loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: home });
    expect(loaded.source).toBe("file");
    expect(loaded.table.classifier.guidance).toBe("home-level table");
  });

  testIfDocker("an invalid nearest table fails loudly instead of falling through", async () => {
    const root = await makeTempDir();
    const home = await makeTempDir();
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".duet"), { recursive: true });
    await writeFile(join(cwd, ".duet", "models.json"), "{ not json");
    await mkdir(join(home, ".duet"), { recursive: true });
    await writeFile(join(home, ".duet", "models.json"), JSON.stringify(BUILT_IN_ROUTING_TABLE));

    await expect(loadRoutingTable({ cwd, catalogAdapter: catalog, homeDir: home })).rejects.toThrow(
      /Failed to parse routing table/,
    );
  });
});
