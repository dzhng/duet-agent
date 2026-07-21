import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CAMPAIGN_CONFIGS,
  renderCampaignConfigs,
  serializeModelsJson,
} from "../src/config-override.js";
import {
  CAMPAIGN_GOLD_EXCLUSIONS,
  LANGUAGES,
  REPO_LANGUAGE,
  selectManifest,
  selectPilotInstanceIds,
  serializeManifest,
  type DatasetRow,
  type DatasetSnapshot,
} from "../src/manifest.js";
import { BUILT_IN_ROUTING_TABLE, validateRoutingTable } from "../../../src/model-routing/table.js";
import { routingCatalogAdapter } from "../../../src/model-resolution/resolver.js";

function fixtureSnapshot(): DatasetSnapshot {
  const rows: DatasetRow[] = [];
  for (const [repo, language] of Object.entries(REPO_LANGUAGE)) {
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        repo,
        instanceId: `${language.replaceAll("+", "p").toLowerCase()}__${repo.replaceAll("/", "__")}-${index}`,
        baseCommit: `${index}`.repeat(40),
        problemStatement: `Fix ${language} fixture ${index}`,
      });
    }
  }
  return { datasetRevision: "fixture-revision", rows };
}

function changedPaths(left: unknown, right: unknown, path = ""): string[] {
  if (Object.is(left, right)) return [];
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return [path];
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].flatMap((key) =>
    changedPaths(leftRecord[key], rightRecord[key], path ? `${path}.${key}` : key),
  );
}

describe("SWE-bench manifest", () => {
  test("selects a byte-identical, revision-pinned nine-language sample", () => {
    const snapshot = fixtureSnapshot();
    const first = selectManifest(snapshot, { seed: 12345, size: 30 });
    const second = selectManifest(
      { ...snapshot, rows: [...snapshot.rows].reverse() },
      { seed: 12345, size: 30 },
    );

    expect(serializeManifest(first)).toBe(serializeManifest(second));
    expect(first.datasetRevision).toBe("fixture-revision");
    expect(first.excludedInstanceIds).toEqual([]);
    expect(first.entries).toHaveLength(30);
    const counts = LANGUAGES.map(
      (language) => first.entries.filter((entry) => entry.language === language).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(first.entries.every((entry) => REPO_LANGUAGE[entry.repo] === entry.language)).toBe(true);
  });

  test("replaces an incompatible task without perturbing other language buckets", () => {
    const snapshot = fixtureSnapshot();
    const original = selectManifest(snapshot, { seed: 12345, size: 30 });
    const excludedEntry = original.entries.find((entry) => entry.language === "C++")!;
    const replacement = selectManifest(snapshot, {
      seed: 12345,
      size: 30,
      excludedInstanceIds: [excludedEntry.instanceId],
    });

    expect(replacement.excludedInstanceIds).toEqual([excludedEntry.instanceId]);
    expect(replacement.entries.map((entry) => entry.instanceId)).not.toContain(
      excludedEntry.instanceId,
    );
    expect(replacement.entries).toHaveLength(30);
    for (const language of LANGUAGES.filter((candidate) => candidate !== "C++")) {
      expect(replacement.entries.filter((entry) => entry.language === language)).toEqual(
        original.entries.filter((entry) => entry.language === language),
      );
    }
  });

  test("selects a seeded pilot with one instance per language", () => {
    const manifest = selectManifest(fixtureSnapshot(), { seed: 12345, size: 30 });
    const first = selectPilotInstanceIds(manifest, { seed: 67890, size: 3 });
    const second = selectPilotInstanceIds(manifest, { seed: 67890, size: 3 });
    const entriesById = new Map(manifest.entries.map((entry) => [entry.instanceId, entry]));

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((id) => entriesById.get(id)!.language)).size).toBe(3);
  });

  test("rejects unclassified repositories instead of guessing", () => {
    const snapshot = fixtureSnapshot();
    snapshot.rows.push({
      repo: "unknown/repo",
      instanceId: "unknown__repo-1",
      baseCommit: "a",
      problemStatement: "Unknown repository fixture",
    });

    expect(() => selectManifest(snapshot, { seed: 1, size: 30 })).toThrow(
      "Unknown SWE-bench Multilingual repository: unknown/repo.",
    );
  });

  test("commits the selected values and every language, not only the expected size", async () => {
    const path = join(import.meta.dir, "..", "manifests", "multilingual-30.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as ReturnType<typeof selectManifest>;

    expect(manifest.datasetRevision).toBe("2b7aced941b4873e9cad3e76abbae93f481d1beb");
    expect(manifest.seed).toBe(20_260_720);
    expect(manifest.algorithmVersion).toBe("language-stratified-v2");
    expect(manifest.excludedInstanceIds).toEqual(Object.keys(CAMPAIGN_GOLD_EXCLUSIONS).sort());
    expect(manifest.entries.map((entry) => entry.instanceId)).toEqual(
      manifest.entries.map((entry) => entry.instanceId).sort(),
    );
    expect(
      Object.fromEntries(
        LANGUAGES.map((language) => [
          language,
          manifest.entries.filter((entry) => entry.language === language).length,
        ]),
      ),
    ).toEqual({
      C: 3,
      "C++": 3,
      Go: 4,
      Java: 4,
      JavaScript: 3,
      TypeScript: 3,
      PHP: 3,
      Ruby: 4,
      Rust: 3,
    });
    expect(manifest.entries.every((entry) => REPO_LANGUAGE[entry.repo] === entry.language)).toBe(
      true,
    );
    expect(
      manifest.entries.filter((entry) => entry.language === "C++").map((entry) => entry.instanceId),
    ).toEqual(["fmtlib__fmt-1683", "fmtlib__fmt-2457", "fmtlib__fmt-3729"]);
  });

  test("freezes a fresh fifty-task sample without reusing the prior manifest", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(import.meta.dir, "..", "manifests", "multilingual-50-fresh-20265471.json"),
        "utf8",
      ),
    ) as ReturnType<typeof selectManifest>;
    const priorManifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "manifests", "multilingual-30.json"), "utf8"),
    ) as ReturnType<typeof selectManifest>;
    const priorInstanceIds = new Set(priorManifest.entries.map((entry) => entry.instanceId));

    expect(manifest.seed).toBe(20_265_471);
    expect(manifest.entries).toHaveLength(50);
    expect(manifest.entries.filter((entry) => priorInstanceIds.has(entry.instanceId))).toEqual([]);
    expect(
      Object.fromEntries(
        LANGUAGES.map((language) => [
          language,
          manifest.entries.filter((entry) => entry.language === language).length,
        ]),
      ),
    ).toEqual({
      C: 6,
      "C++": 6,
      Go: 6,
      Java: 5,
      JavaScript: 5,
      TypeScript: 5,
      PHP: 6,
      Ruby: 5,
      Rust: 6,
    });
  });

  test("commits a pilot subset that matches its recorded selection seed", async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "manifests", "multilingual-30.json"), "utf8"),
    ) as ReturnType<typeof selectManifest>;
    for (const filename of ["pilot-3-v2.json", "pilot-3-v3.json"]) {
      const campaign = JSON.parse(
        await readFile(join(import.meta.dir, "..", "campaigns", filename), "utf8"),
      ) as { instanceIds: string[]; instanceSelectionSeed: number };

      expect(campaign.instanceIds).toEqual(
        selectPilotInstanceIds(manifest, {
          seed: campaign.instanceSelectionSeed,
          size: campaign.instanceIds.length,
        }),
      );
    }
  });
});

describe("SWE-bench routing renders", () => {
  test("materializes five valid custom-tier tables with explicit targets", () => {
    const renders = renderCampaignConfigs();

    expect(Object.keys(renders)).toEqual(Object.keys(CAMPAIGN_CONFIGS));
    for (const table of Object.values(renders)) {
      expect(table.defaultTier).toBe("swebench");
      expect(Object.keys(table.tiers)).toEqual(["swebench"]);
      expect(validateRoutingTable(table, routingCatalogAdapter)).toEqual([]);
      expect(table.classifier).toEqual(BUILT_IN_ROUTING_TABLE.classifier);
      expect(table.tiers.swebench!.routes.general!.description).toBe(
        BUILT_IN_ROUTING_TABLE.tiers.economy.routes.implement.description,
      );
      expect(table.tiers.swebench!.routes.general!.visionFallbackModelName).toBe("kimi-k3");
      expect(table.tiers.swebench!.advisor.minStepsBetween).toBe(
        BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor.minStepsBetween,
      );
    }

    expect(renders["glm-pure"].tiers.swebench!.routes.general!.target).toEqual({
      modelName: "glm-5.2",
      thinkingLevel: "high",
    });
    expect(renders["glm-pure"].tiers.swebench!.advisor.target).toEqual({
      modelName: "kimi-k3",
      thinkingLevel: "medium",
    });
    expect(renders["kimi-pure"].tiers.swebench!.routes.general!.target).toEqual({
      modelName: "kimi-k3",
      thinkingLevel: "high",
    });
    expect(renders["kimi-pure"].tiers.swebench!.advisor.target).toEqual({
      modelName: "fable-5",
      thinkingLevel: "high",
    });
    expect(renders["opus-pure"].tiers.swebench!.routes.general!.target).toEqual({
      modelName: "opus-4.8",
      thinkingLevel: "high",
    });
    expect(renders["opus-pure"].tiers.swebench!.advisor).toMatchObject({
      enabled: false,
      target: { modelName: "fable-5", thinkingLevel: "high" },
    });
  });

  test("changes exactly one advisor boolean inside each paired comparison", () => {
    const renders = renderCampaignConfigs();

    expect(changedPaths(renders["glm-pure"], renders["glm-kimi-advisor"])).toEqual([
      "tiers.swebench.advisor.enabled",
    ]);
    expect(changedPaths(renders["kimi-pure"], renders["kimi-fable-advisor"])).toEqual([
      "tiers.swebench.advisor.enabled",
    ]);
  });

  test("keeps every committed routing file byte-identical to its renderer", async () => {
    const renders = renderCampaignConfigs();
    for (const name of Object.keys(CAMPAIGN_CONFIGS) as (keyof typeof CAMPAIGN_CONFIGS)[]) {
      const path = join(import.meta.dir, "..", "configs", `${name}.models.json`);
      expect(await readFile(path, "utf8")).toBe(serializeModelsJson(renders[name]));
    }
  });
});
