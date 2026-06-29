import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { Session } from "../src/session/session.js";
import { applyInlineSlashCommands } from "../src/tui/slash-commands.js";
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

  testIfDocker(
    "setThinkingLevel mutates config.thinkingLevel and is picked up on next start",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-thinking-set-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "thinking-session");
      await mkdir(sessionPath, { recursive: true });

      const session = new Session(
        {
          model: "anthropic:claude-opus-4-7",
          thinkingLevel: "medium",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "thinking-session", sessionPath },
      );

      const result = session.setThinkingLevel("HIGH");
      expect(result.thinkingLevel).toBe("high");
      expect(session.config.thinkingLevel).toBe("high");

      await session.start();
      await session.dispose();

      const stored = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf-8"));
      expect(stored.state.options.thinkingLevel).toBe("high");
    },
  );

  testIfDocker("setThinkingLevel rejects unknown levels without mutating config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "duet-thinking-set-bad-"));
    tempDirs.push(tempDir);
    const sessionPath = join(tempDir, "thinking-bad-session");
    await mkdir(sessionPath, { recursive: true });

    const session = new Session(
      {
        model: "anthropic:claude-opus-4-7",
        thinkingLevel: "medium",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      },
      { id: "thinking-bad-session", sessionPath },
    );

    expect(() => session.setThinkingLevel("ultra")).toThrow();
    expect(session.config.thinkingLevel).toBe("medium");
  });

  // Inline contract: when /model appears inside a longer prompt, the swap
  // must take effect *before* the remainder dispatches as a prompt, so the
  // turn that delivers the remainder uses the newly-selected model. This
  // is the "hey can you review this /model gpt-5.5" flow.
  testIfDocker(
    "inline /model mutates config.model before the remainder is dispatched",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-model-inline-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "inline-session");
      await mkdir(sessionPath, { recursive: true });

      const session = new Session(
        {
          model: "anthropic:claude-opus-4-7",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "inline-session", sessionPath },
      );

      // Minimal stub that exercises only the SlashCommandContext surface
      // the inline extractor touches when /model is the matched command.
      const blocks: Array<{ label: string | null; body: string }> = [];
      const ctx = {
        appendBlock: (label: string | null, body: string) => {
          blocks.push({ label, body });
        },
        onClear: () => {},
        setModel: (model: string) => session.setModel(model),
        setThinkingLevel: (level: string) => session.setThinkingLevel(level),
      };

      const message = "hey can you review this /model anthropic:claude-sonnet-5-1";
      const { handledCommands } = applyInlineSlashCommands(message, ctx);

      // The mutation has to be observable on the live config before the
      // caller dispatches the prompt — otherwise the turn that delivers
      // this very message would still land on the previously-configured
      // model. The message itself is NOT touched: the slash stays in the
      // prompt the agent sees, mirroring how `/skill-name` references
      // survive the dispatch.
      expect(session.config.model).toBe("anthropic:claude-sonnet-5-1");
      expect(handledCommands).toEqual(["model"]);
      expect(blocks.some((b) => b.label === "[model]")).toBe(true);

      // Run a real turn to confirm the runner picks up the new model on the
      // prompt that carries the remainder, not just on some later turn.
      await session.start();
      await session.dispose();
      const stored = JSON.parse(await readFile(join(sessionPath, "state.json"), "utf-8"));
      expect(stored.state.options.model).toBe("anthropic:claude-sonnet-5-1");
    },
  );

  // The inline path must absorb validation failures: a typo'd model
  // name should not crash the prompt dispatch or silently swap config.
  // The handler renders a red [model] block via appendBlock, leaves
  // session.config.model untouched, and lets the original prompt run on
  // the previously-configured model.
  testIfDocker(
    "inline /model with a rejected name leaves config.model untouched and surfaces an error block",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-model-inline-bad-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "inline-bad-session");
      await mkdir(sessionPath, { recursive: true });

      const session = new Session(
        {
          model: "anthropic:claude-opus-4-7",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "inline-bad-session", sessionPath },
      );

      const blocks: Array<{ label: string | null; body: string }> = [];
      const ctx = {
        appendBlock: (label: string | null, body: string) => {
          blocks.push({ label, body });
        },
        onClear: () => {},
        setModel: (model: string) => session.setModel(model),
        setThinkingLevel: (level: string) => session.setThinkingLevel(level),
      };

      applyInlineSlashCommands("hey /model totally-not-a-real-model please review this", ctx);

      expect(session.config.model).toBe("anthropic:claude-opus-4-7");
      const errorBlock = blocks.find((b) => b.label === "[model]");
      expect(errorBlock).toBeDefined();
      // Body comes straight from resolveModelName — the canonical message
      // for an unresolvable shorthand. We assert on the shape, not the
      // exact wording, so resolver copy can evolve without breaking this.
      expect(errorBlock?.body).toMatch(/totally-not-a-real-model/);
    },
  );

  // Same shape for /thinking: a bogus level shows the error block and
  // never mutates the config.
  testIfDocker(
    "inline /thinking with a rejected level leaves config.thinkingLevel untouched",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-thinking-inline-bad-"));
      tempDirs.push(tempDir);
      const sessionPath = join(tempDir, "inline-bad-thinking");
      await mkdir(sessionPath, { recursive: true });

      const session = new Session(
        {
          model: "anthropic:claude-opus-4-7",
          thinkingLevel: "medium",
          memoryDbPath: false,
          skillDiscovery: { includeDefaults: false },
        },
        { id: "inline-bad-thinking", sessionPath },
      );

      const blocks: Array<{ label: string | null; body: string }> = [];
      const ctx = {
        appendBlock: (label: string | null, body: string) => {
          blocks.push({ label, body });
        },
        onClear: () => {},
        setModel: (model: string) => session.setModel(model),
        setThinkingLevel: (level: string) => session.setThinkingLevel(level),
      };

      applyInlineSlashCommands("think harder /thinking ultra please", ctx);

      expect(session.config.thinkingLevel).toBe("medium");
      const errorBlock = blocks.find((b) => b.label === "[thinking]");
      expect(errorBlock?.body).toMatch(/Unknown thinking level: ultra/);
      expect(errorBlock?.body).toMatch(/minimal, low, medium, high, xhigh/);
    },
  );

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
