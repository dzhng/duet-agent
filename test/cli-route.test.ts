import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConfigCommand } from "../src/cli/config.js";
import { parseRouteArgs, runRouteCommand } from "../src/cli/route.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { testIfDocker } from "./helpers/docker-only.js";

describe("parseRouteArgs", () => {
  test("parses tier, images, JSON, and a multi-word prompt", () => {
    expect(
      parseRouteArgs(["--model", "economy", "--images", "--json", "fix", "the", "layout"]),
    ).toEqual({
      model: "economy",
      images: true,
      json: true,
      help: false,
      prompt: "fix the layout",
    });
  });

  test("rejects unknown options and missing model values", () => {
    expect(() => parseRouteArgs(["--unknown", "work"])).toThrow("Unknown route option");
    expect(() => parseRouteArgs(["--model"])).toThrow("Missing value for --model");
  });

  test("parses advisor-preview with an optional stored session id", () => {
    expect(parseRouteArgs(["advisor-preview", "--session", "session_fixture"])).toEqual({
      images: false,
      json: false,
      help: false,
      advisorPreview: true,
      session: "session_fixture",
    });
    expect(() => parseRouteArgs(["advisor-preview", "--session"])).toThrow(
      "Missing value for --session",
    );
  });
});

describe("runRouteCommand", () => {
  const originalDuetKey = process.env.DUET_API_KEY;

  beforeEach(() => {
    process.env.DUET_API_KEY = "test-duet-key";
  });

  afterEach(() => {
    if (originalDuetKey === undefined) delete process.env.DUET_API_KEY;
    else process.env.DUET_API_KEY = originalDuetKey;
  });

  test("prints the stable JSON decision shape with a stubbed classifier", async () => {
    let output = "";
    let classifierDelta: string | undefined;
    const ticks = [100, 137];
    const result = await runRouteCommand(["--json", "implement the parser"], {
      cwd: process.cwd(),
      write: (text) => {
        output += text;
      },
      now: () => ticks.shift()!,
      classify: async (input) => {
        classifierDelta = input.lastStepDelta;
        return {
          route: "implement",
          rationale: "The request asks for implementation.",
        };
      },
    });

    expect(JSON.parse(output)).toEqual({
      tier: "frontier",
      route: "implement",
      model: "gpt-5.6-sol",
      effort: "high",
      rationale: "The request asks for implementation.",
      resolutionChain: ["frontier"],
      tableSource: "built-in",
      latencyMs: 37,
    });
    expect(result).toEqual(JSON.parse(output));
    expect(classifierDelta).toBe("implement the parser");
  });

  test("surfaces an unknown tier before calling the classifier", async () => {
    let classifierCalled = false;
    await expect(
      runRouteCommand(["--model", "missing", "prompt"], {
        classify: async () => {
          classifierCalled = true;
          return { route: "general", rationale: "unused" };
        },
      }),
    ).rejects.toThrow('Unknown virtual model tier "missing".');
    expect(classifierCalled).toBe(false);
  });

  test("prints a read-only advisor preview for the newest stored fixture session", async () => {
    let output = "";
    const sessionsRoot = join(process.cwd(), "test", "fixtures", "advisor-preview");
    const result = await runRouteCommand(["advisor-preview"], {
      cwd: process.cwd(),
      sessionsRoot,
      write: (text) => {
        output += text;
      },
    });

    if (!result || !("transcript" in result)) throw new Error("Expected advisor preview result");
    expect(result.sessionId).toBe("session_fixture");
    expect(result.tier).toBe("frontier");
    expect(typeof result.tokens).toBe("number");
    expect(result.estimates.map(({ tier, model, enabled }) => ({ tier, model, enabled }))).toEqual([
      { tier: "frontier", model: "fable-5", enabled: true },
      { tier: "balanced", model: "fable-5", enabled: true },
      { tier: "economy", model: "gpt-5.6-terra", enabled: false },
    ]);
    expect(result.estimates.every((estimate) => typeof estimate.inputUsd === "number")).toBe(true);
    expect(result.transcript).toContain("Design the model router before implementing it.");
    expect(result.transcript).toContain('"systemPrompt"');
    expect(result.transcript).toContain('"tools"');
    expect(output).toContain("Session: session_fixture");
    expect(output).toContain(`Transcript tokens: ${result.tokens}`);
    expect(output).toContain("frontier: fable-5");
    expect(output).toContain("economy: gpt-5.6-terra (disabled)");
    expect(output).toContain(result.transcript);
  });
});

describe("runConfigCommand", () => {
  testIfDocker("exports the built-in table and refuses overwrite without --force", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "duet-route-config-"));
    try {
      await runConfigCommand(["export"], { cwd, write: () => {} });
      const path = join(cwd, ".duet", "models.json");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(BUILT_IN_ROUTING_TABLE);
      await expect(runConfigCommand(["export"], { cwd, write: () => {} })).rejects.toThrow(
        "pass force to overwrite it",
      );
      await expect(
        runConfigCommand(["export", "--force"], { cwd, write: () => {} }),
      ).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(BUILT_IN_ROUTING_TABLE);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
