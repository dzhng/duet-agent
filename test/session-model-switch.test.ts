import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { Session } from "../src/session/session.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("Session model-switch persistence", () => {
  // Resume must let a new --model override the previously persisted state.options.model.
  // Without that override, sessions would silently keep running on whatever model was used
  // at first start, regardless of the user's current CLI flag.
  testIfDocker(
    "resume with a new --model overwrites state.options.model in state.json",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-model-switch-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "switch-session");
      await mkdir(sessionPath, { recursive: true });

      // First session: persist state with model A.
      const first = new Session(
        {
          model: "anthropic:claude-opus-4-7",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "switch-session", sessionPath },
      );
      await first.start();
      await first.dispose();

      const stateAfterFirst = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf-8"));
      expect(stateAfterFirst.state.options.model).toBe("anthropic:claude-opus-4-7");

      // Resume the same session path with model B.
      const second = new Session(
        {
          model: "anthropic:claude-sonnet-5-1",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "switch-session", sessionPath, resumeFromStorage: true },
      );
      await second.start();
      await second.dispose();

      const stateAfterSecond = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf-8"));
      expect(stateAfterSecond.state.options.model).toBe("anthropic:claude-sonnet-5-1");
    },
  );

  // setModel() lets the TUI's /model slash command swap the model used for
  // subsequent turns. The change is config-level only — it must take effect
  // on the next prompt without touching any in-flight turn.
  testIfDocker("setModel mutates config.model and is picked up on next start", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-model-set-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "set-session");
    await mkdir(sessionPath, { recursive: true });

    const session = new Session(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { id: "set-session", sessionPath },
    );

    const result = session.setModel("anthropic:claude-sonnet-5-1");
    expect(result.modelName).toBe("anthropic:claude-sonnet-5-1");
    expect(session.config.model).toBe("anthropic:claude-sonnet-5-1");

    await session.start();
    await session.dispose();

    const stored = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf-8"));
    expect(stored.state.options.model).toBe("anthropic:claude-sonnet-5-1");
  });

  testIfDocker("setModel rejects unknown model shorthands without mutating config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-model-set-bad-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "bad-session");
    await mkdir(sessionPath, { recursive: true });

    const session = new Session(
      {
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { id: "bad-session", sessionPath },
    );

    expect(() => session.setModel("not-a-real-model-shorthand")).toThrow();
    expect(session.config.model).toBe("anthropic:claude-opus-4-7");

    expect(() => session.setModel("   ")).toThrow();
    expect(session.config.model).toBe("anthropic:claude-opus-4-7");
  });
});
