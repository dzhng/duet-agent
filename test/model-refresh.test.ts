import { pinnedDefaultModel, pinnedMemoryModel } from "../src/model-resolution/catalog.js";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliTurnConfig } from "../src/cli/run.js";
import { Session } from "../src/session/session.js";
import { resolveCliModel, resolveModelName } from "../src/model-resolution/resolver.js";
import providerBaseline from "./fixtures/model-refresh/provider-baseline.json" with { type: "json" };
import otherFamilies from "./fixtures/model-refresh/other-families-baseline.json" with { type: "json" };
import baseline from "./fixtures/model-refresh/standalone-baseline.json" with { type: "json" };
import { modelRefreshCompletion } from "./helpers/model-refresh-upstream.js";
import { testIfDocker } from "./helpers/docker-only.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("CLI selections retain the family intent before execution", () => {
  for (const input of ["opus", "sol", "terra", "luna"]) {
    expect(resolveCliModel(input, new Set()).modelName).toBe(input);
  }
}, 30_000);

testIfDocker(
  "baseline CLI selections resume onto current models without rewriting history",
  async () => {
    const previousBase = process.env.DUET_GATEWAY_BASE_URL;
    const requests: Array<{ model: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const payload = (await request.json()) as { model: string };
        requests.push(payload);
        return modelRefreshCompletion(payload.model);
      },
    });
    process.env.DUET_GATEWAY_BASE_URL = server.url.toString();
    const previousKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "controlled-refresh-key";
    const dir = await mkdtemp(join(tmpdir(), "model-refresh-"));
    tempDirs.push(dir);
    try {
      for (const receipt of [
        ...baseline.receipts,
        ...otherFamilies.receipts,
        ...providerBaseline.receipts,
      ]) {
        for (const legacyFlags of [false, true]) {
          const sessionPath = join(dir, `${receipt.input}-${legacyFlags}`);
          await mkdir(sessionPath);
          await writeFile(join(sessionPath, "state.json"), JSON.stringify(receipt.envelope));
          const { config } = buildCliTurnConfig(
            {
              workDir: dir,
              incognito: true,
              resume: true,
              ...(legacyFlags
                ? {
                    modelName: receipt.selection.modelName,
                    memoryModelName: receipt.envelope.state.options.memoryModel,
                  }
                : {}),
            },
            new Set(),
          );
          const session = new Session(
            { ...config, skillDiscovery: { includeDefaults: false } },
            {
              id: receipt.input,
              sessionPath,
              resumeFromStorage: true,
            },
          );
          try {
            await session.start();
            expect(session.getState()?.agent.messages as unknown).toEqual(
              receipt.envelope.state.agent.messages,
            );
            await session.prompt({ message: "Continue qualification." });
            expect((await session.waitForTerminal()).type).toBe("complete");
          } finally {
            await session.dispose();
          }
          const saved = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf8"));
          expect(
            saved.state.agent.messages.slice(0, receipt.envelope.state.agent.messages.length),
          ).toEqual(receipt.envelope.state.agent.messages);
          expect(saved.state.options.model).toBe(
            receipt.input === "provider-duet" ? "duet-gateway:opus" : receipt.input,
          );
          const model = resolveModelName(saved.state.options.model);
          const targets: Record<string, string> = {
            "provider-duet": "anthropic/claude-opus-5.5",
            opus: "anthropic/claude-opus-5.5",
            sol: "openai/gpt-6-sol",
            terra: "openai/gpt-6-sol",
            luna: "openai/gpt-6-luna",
            grok: "spacexai/grok-4.7",
            glm: "zai/glm-5.3",
          };
          expect(model.id).toBe(targets[receipt.input]);
          if (receipt.input !== "glm") expect(model.input).toContain("image");
          expect(requests.at(-1)?.model).toBe(model.id);
          expect(saved.state.agent.messages.at(-1).model).toBe(model.id);
        }
      }
    } finally {
      server.stop(true);
      if (previousBase === undefined) delete process.env.DUET_GATEWAY_BASE_URL;
      else process.env.DUET_GATEWAY_BASE_URL = previousBase;
      if (previousKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = previousKey;
    }
  },
  30_000,
);

test("a generated legacy resume command keeps saved family intent while an unrelated pin wins", async () => {
  const { TurnRunner } = await import("../src/turn-runner/turn-runner.js");
  const runner = new TurnRunner({ memoryDbPath: false });
  expect(
    runner.resolveTurnOptions(
      { model: "opus-5", memoryModel: "gpt-5.6-luna" },
      { model: "opus-5", memoryModel: "gpt-5.6-luna" },
    ),
  ).toMatchObject({ model: "opus", memoryModel: "luna" });
  expect(
    runner.resolveTurnOptions({ model: "openrouter:anthropic/claude-opus-5" }, { model: "opus-5" })
      .model,
  ).toBe("openrouter:anthropic/claude-opus-5");
});

testIfDocker(
  "resuming one session cannot change another session's saved selection",
  async () => {
    const { SessionManager } = await import("../src/session/session-manager.js");
    const dir = await mkdtemp(join(tmpdir(), "model-refresh-manager-"));
    tempDirs.push(dir);
    const previousKey = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "controlled";
    const manager = new SessionManager(
      { cwd: dir, memoryDbPath: false, skillDiscovery: { includeDefaults: false } },
      { sessionStoragePath: dir },
    );
    try {
      for (const family of ["sol", "opus"]) {
        const receipt = baseline.receipts.find((item) => item.input === family)!;
        await mkdir(join(dir, family));
        await writeFile(join(dir, family, "state.json"), JSON.stringify(receipt.envelope));
        const session = manager.resume(family);
        await session.start();
        expect(session.getState()?.options?.model).toBe(family);
      }
      expect(manager.get("sol")?.config.model).toBe("sol");
      expect(manager.get("opus")?.config.model).toBe("opus");
    } finally {
      await manager.dispose();
      if (previousKey === undefined) delete process.env.DUET_API_KEY;
      else process.env.DUET_API_KEY = previousKey;
    }
  },
  30_000,
);

test("saved Grok and GLM family selections remain resolvable", async () => {
  const { TurnRunner } = await import("../src/turn-runner/turn-runner.js");
  const runner = new TurnRunner({ memoryDbPath: false });
  for (const receipt of otherFamilies.receipts) {
    const options = runner.resolveTurnOptions(undefined, receipt.envelope.state.options);
    expect(resolveModelName(`duet-gateway:${options.model}`).id).toBe(
      receipt.input === "grok" ? "spacexai/grok-4.7" : "zai/glm-5.3",
    );
  }
});

test("provider defaults retain provider and family intent", () => {
  expect(pinnedDefaultModel("duet-gateway")).toBe("duet-gateway:opus");
  expect(pinnedMemoryModel("duet-gateway")).toBe("duet-gateway:luna");
});

test("all retired curated versions advance on resume without changing the provider", async () => {
  const { TurnRunner } = await import("../src/turn-runner/turn-runner.js");
  const runner = new TurnRunner({ memoryDbPath: false });
  for (const [saved, current] of [
    ["opus-4.8", "opus"],
    ["opus-4.7", "opus"],
    ["glm-4.7", "glm"],
    ["duet:anthropic/claude-opus-5", "duet:opus"],
    ["openrouter:openai/gpt-5.6-terra", "openrouter:terra"],
    ["openai-codex:gpt-5.6-luna", "openai-codex:gpt-6-luna"],
    ["github-copilot:claude-opus-5", "github-copilot:claude-opus-5.5"],
  ])
    expect(runner.resolveTurnOptions(undefined, { model: saved }).model).toBe(current);
});
