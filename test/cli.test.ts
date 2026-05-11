import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildCliTurnConfig,
  cliEnvFilePaths,
  compareSemverVersions,
  detectPackageManagerFromContext,
  formatEnvEntries,
  globalUpgradeCommand,
  loadCliEnvFiles,
  parseResumeHistoryMessages,
  resumeCommand,
  runEnvCommand,
  shouldUseTui,
} from "../src/cli.js";
import {
  resolveCliMemoryModel,
  resolveCliModel,
  resolveModelName,
} from "../src/model-resolution/resolver.js";
import {
  activeSkillAutocompleteToken,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  formatSkillAutocompleteItem,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
  commitActiveAnswer,
  moveQuestionHighlight,
  moveSkillAutocompleteSelection,
  NO_HIGHLIGHT,
  questionPickerAnswer,
  restoreSavedAnswer,
  replaceSkillAutocompleteToken,
  skillAutocompleteMatches,
  startupHeaderLines,
} from "../src/tui/app.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { testIfDocker } from "./helpers/docker-only.js";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AI_GATEWAY_API_KEY",
  "DUET_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();
const EMPTY_DOTENV_KEYS = new Set<string>();
let tempRoot: string | undefined;

for (const key of MODEL_ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function clearModelEnv(): void {
  for (const key of MODEL_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("CLI model inference", () => {
  test("prefers Duet credentials over other supported provider credentials", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_test";
    process.env.AI_GATEWAY_API_KEY = "test-gateway";
    process.env.OPENROUTER_API_KEY = "test-openrouter";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses AI Gateway credentials before OpenRouter, Anthropic, and OpenAI", () => {
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";
    process.env.OPENROUTER_API_KEY = "test-openrouter";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "inferred",
      envVar: "AI_GATEWAY_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "inferred",
      envVar: "AI_GATEWAY_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses OpenRouter credentials before Anthropic and OpenAI", () => {
    clearModelEnv();
    process.env.OPENROUTER_API_KEY = "test-openrouter";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "inferred",
      envVar: "OPENROUTER_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "inferred",
      envVar: "OPENROUTER_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses Anthropic credentials before OpenAI", () => {
    clearModelEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "inferred",
      envVar: "ANTHROPIC_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "inferred",
      envVar: "ANTHROPIC_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses Duet sandbox credentials when only DUET_API_KEY is set", () => {
    // Bare DUET_API_KEY should route through the duet-gateway provider rather
    // than Vercel's gateway directly. The CLI startup shim copies the token
    // into AI_GATEWAY_API_KEY so the underlying vercel-ai-gateway auth path
    // resolves — without the priority ordering this test guards, that shim
    // would silently downgrade the inference to vercel-ai-gateway.
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_test";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses OpenAI credentials when higher-priority providers are absent", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.5",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
  });

  test("falls back to built-in model defaults when no supported provider credentials exist", () => {
    clearModelEnv();

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "default",
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "default",
    });
  });

  test("--provider shorthand pins the chat and memory models for that provider", async () => {
    const { resolveProviderShorthand, pinnedDefaultModel, pinnedMemoryModel } =
      await import("../src/model-resolution/catalog.js");

    expect(resolveProviderShorthand("duet")).toBe("duet-gateway");
    expect(resolveProviderShorthand("vercel")).toBe("vercel-ai-gateway");
    expect(resolveProviderShorthand("ai-gateway")).toBe("vercel-ai-gateway");
    expect(resolveProviderShorthand("claude")).toBe("anthropic");
    expect(resolveProviderShorthand("gpt")).toBe("openai");
    expect(resolveProviderShorthand("bogus")).toBeUndefined();

    expect(pinnedDefaultModel("openai")).toBe("openai:gpt-5.5");
    expect(pinnedMemoryModel("openai")).toBe("openai:gpt-5.4-mini");
    expect(pinnedDefaultModel("anthropic")).toBe("anthropic:claude-opus-4-7");
  });

  test("keeps an explicitly provided model", () => {
    clearModelEnv();

    expect(resolveCliModel("openai:gpt-5.5", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "openai:gpt-5.5",
      source: "explicit",
    });
  });

  test("keeps explicitly provided model shorthands as app-facing names", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_test";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    expect(resolveCliModel("opus-4.7", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "opus-4.7",
      source: "explicit",
    });
    expect(resolveCliModel("gpt-5.5", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.5",
      source: "explicit",
    });
  });

  test("resolves model shorthand through the first configured provider", () => {
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    expect(resolveModelName("opus-4.7").id).toBe("anthropic/claude-opus-4.7");
    expect(resolveModelName("gpt-5.5").id).toBe("openai/gpt-5.5");
  });

  test("rejects model shorthand when no supported provider credentials are configured", () => {
    clearModelEnv();

    expect(() => resolveModelName("opus-4.7")).toThrow(
      "Model shorthand requires credentials for a supported provider: opus-4.7",
    );
    expect(() => resolveModelName("gpt-5.5")).toThrow(
      "Model shorthand requires credentials for a supported provider: gpt-5.5",
    );
  });

  test("provider:modelId syntax pins a specific provider", () => {
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";

    expect(resolveModelName("anthropic:claude-opus-4-7").id).toBe("claude-opus-4-7");
  });

  test("keeps explicitly provided memory model shorthands as app-facing names", () => {
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";

    expect(resolveCliMemoryModel("haiku-4.5", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "haiku-4.5",
      source: "explicit",
    });
    expect(resolveCliMemoryModel("gpt-5.4-mini", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
      source: "explicit",
    });
  });

  test("keeps an explicitly provided memory model", () => {
    expect(resolveCliMemoryModel("anthropic:claude-3-5-haiku-latest", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "anthropic:claude-3-5-haiku-latest",
      source: "explicit",
    });
  });

  test("builds CLI config from explicit shorthand model flags", () => {
    clearModelEnv();

    const { config, modelResolution, memoryModelResolution } = buildCliTurnConfig(
      {
        modelName: "opus-4.7",
        memoryModelName: "haiku-4.5",
        workDir: "/repo",
      },
      EMPTY_DOTENV_KEYS,
    );

    expect(config).toMatchObject({
      model: "opus-4.7",
      memoryModel: "haiku-4.5",
      cwd: "/repo",
    });
    expect(modelResolution).toEqual({
      modelName: "opus-4.7",
      source: "explicit",
    });
    expect(memoryModelResolution).toEqual({
      modelName: "haiku-4.5",
      source: "explicit",
    });
  });

  test("builds CLI config from inferred shorthand defaults", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";

    const { config, modelResolution, memoryModelResolution } = buildCliTurnConfig(
      {
        incognito: true,
        workDir: "/repo",
        systemInstructions: "Prefer concise answers.",
        systemPromptFiles: [],
      },
      EMPTY_DOTENV_KEYS,
    );

    expect(config).toEqual({
      model: "gpt-5.5",
      memoryModel: "gpt-5.4-mini",
      memoryDbPath: false,
      cwd: "/repo",
      systemInstructions: "Prefer concise answers.",
      systemPromptFiles: [],
    });
    expect(modelResolution).toEqual({
      modelName: "gpt-5.5",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
    expect(memoryModelResolution).toEqual({
      modelName: "gpt-5.4-mini",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
  });
});

describe("CLI env files", () => {
  testIfDocker("loads workdir .env before the shared env file", async () => {
    clearModelEnv();
    tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
    const workDir = join(tempRoot, "project");
    const sharedEnv = join(tempRoot, "shared.env");
    await mkdir(workDir);
    await writeFile(join(workDir, ".env"), "ANTHROPIC_API_KEY=from-workdir\n");
    await writeFile(sharedEnv, "ANTHROPIC_API_KEY=from-shared\nOPENAI_API_KEY=from-shared\n");

    const dotenvKeys = loadCliEnvFiles(workDir, sharedEnv);

    expect(process.env.ANTHROPIC_API_KEY).toBe("from-workdir");
    expect(process.env.OPENAI_API_KEY).toBe("from-shared");
    expect(dotenvKeys).toEqual(new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]));
  });

  test("resolves relative custom env files from the workdir", () => {
    expect(cliEnvFilePaths("/repo", ".duet-env")).toEqual(["/repo/.env", "/repo/.duet-env"]);
  });

  testIfDocker("formats env entries with shell-safe quoting", () => {
    expect(
      formatEnvEntries(
        new Map([
          ["DUET_API_KEY", "duet_gt_test"],
          ["OPENAI_API_KEY", "value with spaces"],
        ]),
      ),
    ).toBe('DUET_API_KEY=duet_gt_test\nOPENAI_API_KEY="value with spaces"\n');
  });

  testIfDocker("env import without a path imports cwd .env into a custom env file", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
    const workDir = join(tempRoot, "project");
    const targetEnv = join(tempRoot, "duet.env");
    await mkdir(workDir);
    await writeFile(join(workDir, ".env"), "DUET_API_KEY=duet_gt_test\n");

    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runEnvCommand(["--env-file", targetEnv, "--import"], { cwd: workDir });
    } finally {
      stderr.mockRestore();
    }

    expect(await readFile(targetEnv, "utf8")).toBe("DUET_API_KEY=duet_gt_test\n");
  });

  testIfDocker("env import only copies recognized provider keys from the source", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
    const workDir = join(tempRoot, "project");
    const targetEnv = join(tempRoot, "duet.env");
    await mkdir(workDir);
    await writeFile(
      join(workDir, ".env"),
      [
        "DUET_API_KEY=duet_gt_test",
        "OPENAI_API_KEY=openai_test",
        "DATABASE_URL=postgres://example",
        "STRIPE_SECRET_KEY=sk_test_unrelated",
        "",
      ].join("\n"),
    );

    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runEnvCommand(["--env-file", targetEnv, "--import"], { cwd: workDir });
    } finally {
      stderr.mockRestore();
    }

    expect(await readFile(targetEnv, "utf8")).toBe(
      "DUET_API_KEY=duet_gt_test\nOPENAI_API_KEY=openai_test\n",
    );
  });

  testIfDocker(
    "env import with a path merges that env file into an existing custom env file",
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
      const workDir = join(tempRoot, "project");
      const targetEnv = join(tempRoot, "duet.env");
      await mkdir(workDir);
      await writeFile(
        join(workDir, ".env"),
        "DUET_API_KEY=duet_gt_new\nANTHROPIC_API_KEY=anthropic_new\n",
      );
      await writeFile(targetEnv, "DUET_API_KEY=duet_gt_old\nOPENAI_API_KEY=openai_existing\n");

      const stderr = spyOn(console, "error").mockImplementation(() => {});
      try {
        await runEnvCommand(["--env-file", targetEnv, "--import", join(workDir, ".env")]);
      } finally {
        stderr.mockRestore();
      }

      expect(await readFile(targetEnv, "utf8")).toBe(
        "DUET_API_KEY=duet_gt_new\nOPENAI_API_KEY=openai_existing\nANTHROPIC_API_KEY=anthropic_new\n",
      );
    },
  );

  testIfDocker("env keys writes prompted provider API keys to a custom env file", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
    const workDir = join(tempRoot, "project");
    const targetEnv = join(tempRoot, "duet.env");
    await mkdir(workDir);

    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runEnvCommand(["--env-file", targetEnv, "--keys"], {
        cwd: workDir,
        interactive: true,
        promptForApiKeys: async () =>
          new Map([
            ["DUET_API_KEY", "duet_gt_test"],
            ["OPENAI_API_KEY", "openai_test"],
          ]),
      });
    } finally {
      stderr.mockRestore();
    }

    expect(await readFile(targetEnv, "utf8")).toBe(
      "DUET_API_KEY=duet_gt_test\nOPENAI_API_KEY=openai_test\n",
    );
  });

  testIfDocker("env without an action prints help and does not write an env file", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-env-"));
    const workDir = join(tempRoot, "project");
    const targetEnv = join(tempRoot, "duet.env");
    await mkdir(workDir);
    await writeFile(join(workDir, ".env"), "DUET_API_KEY=duet_gt_test\n");

    let printedHelp = false;
    await runEnvCommand(["--env-file", targetEnv], {
      cwd: workDir,
      interactive: true,
      printHelp: () => {
        printedHelp = true;
      },
    });

    await expect(readFile(targetEnv, "utf8")).rejects.toThrow();
    expect(printedHelp).toBe(true);
  });
});

describe("CLI version checks", () => {
  test("compares semantic versions", () => {
    expect(compareSemverVersions("0.1.3", "0.1.2")).toBe(1);
    expect(compareSemverVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareSemverVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });
});

describe("CLI resume command", () => {
  test("preserves incognito mode", () => {
    expect(
      resumeCommand("session_123", {
        modelName: "opus-4.7",
        memoryModelName: "haiku-4.5",
        workDir: "/repo",
        incognito: true,
      }),
    ).toContain("--incognito");
  });
});

describe("CLI render mode", () => {
  test("uses TUI only for interactive sessions without a prompt", () => {
    expect(shouldUseTui({ interactive: true, jsonOutput: false })).toBe(true);
    expect(shouldUseTui({ interactive: true, jsonOutput: false, prompt: "hi" })).toBe(false);
    expect(shouldUseTui({ interactive: true, jsonOutput: true })).toBe(false);
    expect(shouldUseTui({ interactive: false, jsonOutput: false, prompt: "hi" })).toBe(false);
  });
});

describe("CLI resume history display", () => {
  test("parses non-negative resume history message limits", () => {
    expect(parseResumeHistoryMessages("0")).toBe(0);
    expect(parseResumeHistoryMessages("5")).toBe(5);
    expect(() => parseResumeHistoryMessages("-1")).toThrow(
      "--resume-history-messages must be a non-negative integer",
    );
    expect(() => parseResumeHistoryMessages("all")).toThrow(
      "--resume-history-messages must be a non-negative integer",
    );
  });

  test("limits resumed history to the newest user-turn exchanges", () => {
    const limited = limitHistoryDisplayMessages(
      [
        { kind: "user", content: "you:\noldest question" },
        { kind: "agent", content: "oldest answer" },
        { kind: "user", content: "you:\nmiddle question" },
        { kind: "agent", content: "middle answer" },
        { kind: "user", content: "you:\nnew question" },
        { kind: "tool", content: "[tool read] ✓" },
        { kind: "agent", content: "line one\nline two" },
      ],
      2,
    );

    expect(limited.omittedBlocks).toBe(2);
    expect(limited.blocks.map((block) => block.content)).toEqual([
      "you:\nmiddle question",
      "middle answer",
      "you:\nnew question",
      "[tool read] ✓",
      "line one\nline two",
    ]);
  });

  test("drops orphan blocks before the first kept user turn", () => {
    const limited = limitHistoryDisplayMessages(
      [
        { kind: "agent", content: "orphan reply" },
        { kind: "tool", content: "orphan tool" },
        { kind: "user", content: "you:\nfirst real prompt" },
        { kind: "agent", content: "answer" },
      ],
      5,
    );

    expect(limited.omittedBlocks).toBe(2);
    expect(limited.blocks.map((block) => block.kind)).toEqual(["user", "agent"]);
  });

  test("zero resume history messages disables replay", () => {
    const limited = limitHistoryDisplayMessages([{ kind: "agent", content: "one\ntwo" }], 0);

    expect(limited.blocks).toEqual([]);
    expect(limited.omittedBlocks).toBe(1);
  });

  test("formats resumed messages before limiting", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      createAssistantMessage({ text: "hi" }),
    ];
    const blocks = historyDisplayBlocks(history);

    expect(blocks).toEqual([
      { kind: "user", content: "you:\nhello" },
      { kind: "agent", content: "hi" },
    ]);
  });

  test("pairs resumed tool calls with their results", () => {
    const history: AgentMessage[] = [
      createAssistantMessage({
        extraContent: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "read_file",
            arguments: { path: "package.json" },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read_file",
        content: [{ type: "text", text: "ok" }],
        details: {},
        isError: false,
        timestamp: 2,
      },
    ];

    expect(historyDisplayBlocks(history)).toEqual([
      {
        kind: "tool",
        content: '[tool read_file] ✓\n{"path":"package.json"}\n[result]\nok',
      },
    ]);
  });

  test("prints startup header before any resumed history", () => {
    const header = startupHeaderLines({
      packageVersion: "0.1.12",
      workDir: "/repo",
      sessionId: "session_123",
      modelName: "opus-4.7",
      modelSource: "default",
      memoryModelName: "haiku-4.5",
    });
    const history = limitHistoryDisplayMessages(
      [
        { kind: "user", content: "you:\nprevious question" },
        { kind: "agent", content: "previous answer" },
      ],
      5,
    );

    expect([...header, ...history.blocks.map((block) => block.content)]).toEqual([
      "[duet] v0.1.12",
      "[cwd] /repo",
      "[session] session_123",
      "[model] opus-4.7 — default",
      "[memory model] haiku-4.5",
      "you:\nprevious question",
      "previous answer",
    ]);
  });
});

describe("TUI skill autocomplete helpers", () => {
  const skills = [
    { name: "review", description: "Review changed code.", path: "/skills/review" },
    { name: "release", description: "Bump version and tag.", path: "/skills/release" },
    { name: "opentui", description: "Build terminal UIs.", path: "/skills/opentui" },
    { name: "react-best-practices", path: "/skills/react-best-practices" },
  ];

  test("detects slash tokens at the cursor anywhere in the prompt", () => {
    expect(activeSkillAutocompleteToken("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(activeSkillAutocompleteToken("please /rev", "please /rev".length)).toEqual({
      start: 7,
      end: 11,
      query: "rev",
    });
    expect(activeSkillAutocompleteToken("please /review now", "please /rev".length)).toEqual({
      start: 7,
      end: 14,
      query: "rev",
    });
  });

  test("ignores non-slash text and invalid slash tokens", () => {
    expect(activeSkillAutocompleteToken("please review", "please review".length)).toBeUndefined();
    expect(
      activeSkillAutocompleteToken("please /bad:name", "please /bad:name".length),
    ).toBeUndefined();
  });

  test("filters skill names by case-insensitive prefix and limit", () => {
    expect(skillAutocompleteMatches(skills, "re").map((skill) => skill.name)).toEqual([
      "react-best-practices",
      "release",
      "review",
    ]);
    expect(skillAutocompleteMatches(skills, "RE", 2).map((skill) => skill.name)).toEqual([
      "react-best-practices",
      "release",
    ]);
  });

  test("preserves skill descriptions and paths in filtered matches", () => {
    expect(skillAutocompleteMatches(skills, "rel", 1)).toEqual([
      { name: "release", description: "Bump version and tag.", path: "/skills/release" },
    ]);
  });

  test("formats autocomplete rows with visible path and description", () => {
    expect(formatSkillAutocompleteItem(skills[0]!)).toBe(
      "/review (/skills/review)\nReview changed code.",
    );
  });

  test("wraps autocomplete descriptions without leading indentation", () => {
    expect(
      formatSkillAutocompleteDescription(
        "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch.",
      ),
    ).toBe(
      "Create new skills, modify and improve existing skills, and measure skill\nperformance. Use when users want to create a skill from scratch.",
    );
  });

  test("wraps autocomplete selection through available matches", () => {
    expect(moveSkillAutocompleteSelection(0, 3, 1)).toBe(1);
    expect(moveSkillAutocompleteSelection(2, 3, 1)).toBe(0);
    expect(moveSkillAutocompleteSelection(0, 3, -1)).toBe(2);
    expect(moveSkillAutocompleteSelection(0, 0, 1)).toBe(0);
  });

  test("replaces the active slash token while preserving surrounding text", () => {
    const text = "please /rev now";
    const token = activeSkillAutocompleteToken(text, "please /rev".length);
    if (!token) throw new Error("Expected slash token");

    expect(token).toEqual({ start: 7, end: 11, query: "rev" });
    expect(replaceSkillAutocompleteToken(text, token, "review")).toEqual({
      text: "please /review now",
      cursorOffset: 14,
    });
  });
});

describe("TUI question picker helpers", () => {
  const singleSelect = {
    question: "Which environment should I deploy to?",
    options: [
      { label: "staging", description: "Deploy to the staging environment first." },
      { label: "production", description: "Deploy directly to production." },
    ],
  };
  const multiSelect = {
    question: "Which test suites should run before promotion?",
    multiSelect: true,
    options: [{ label: "unit" }, { label: "integration" }, { label: "e2e" }],
  };

  test("moveQuestionHighlight wraps and lifts NO_HIGHLIGHT onto the first or last row", () => {
    // From a concrete row, modular wrap.
    expect(moveQuestionHighlight(0, 2, 1)).toBe(1);
    expect(moveQuestionHighlight(1, 2, 1)).toBe(0);
    expect(moveQuestionHighlight(0, 2, -1)).toBe(1);
    // From NO_HIGHLIGHT, Down lands on row 0; Up lands on the last row. This
    // is what makes "no highlight by default" behave like a chat-app picker
    // when the user starts navigating.
    expect(moveQuestionHighlight(NO_HIGHLIGHT, 4, 1)).toBe(0);
    expect(moveQuestionHighlight(NO_HIGHLIGHT, 4, -1)).toBe(3);
    // Empty row count yields NO_HIGHLIGHT (renders as no highlight).
    expect(moveQuestionHighlight(0, 0, 1)).toBe(NO_HIGHLIGHT);
  });

  test("builds a single-element answer for single-select questions", () => {
    expect(questionPickerAnswer(singleSelect, 1, new Set())).toEqual(["production"]);
  });

  test("returns undefined for single-select with NO_HIGHLIGHT", () => {
    // Default state when the user has not yet pressed Up/Down. commitActiveAnswer
    // relies on this to skip writing an answer that the user hasn't expressed.
    expect(questionPickerAnswer(singleSelect, NO_HIGHLIGHT, new Set())).toBeUndefined();
  });

  test("emits checked labels in option order for multi-select questions", () => {
    expect(questionPickerAnswer(multiSelect, 0, new Set([2, 0]))).toEqual(["unit", "e2e"]);
  });

  test("returns an empty array for a multi-select with nothing checked", () => {
    expect(questionPickerAnswer(multiSelect, 0, new Set())).toEqual([]);
  });

  test("returns undefined when the question is missing or has no option at the selection", () => {
    expect(questionPickerAnswer(undefined, 0, new Set())).toBeUndefined();
    expect(questionPickerAnswer(singleSelect, 5, new Set())).toBeUndefined();
  });

  test("commitActiveAnswer live-records multi-select toggles without waiting for Enter", () => {
    // Regression: if the user Space-toggles options and then types a prompt
    // (flushing the picker via `submit()`), the toggled labels must already
    // be in the accumulated map so the dispatched `session.answer` reflects
    // them. Pressing Enter must not be a precondition.
    const accumulated = commitActiveAnswer(multiSelect, 0, new Set([0, 2]), {});
    expect(accumulated).toEqual({
      "Which test suites should run before promotion?": ["unit", "e2e"],
    });
  });

  test("commitActiveAnswer live-records the highlight as a single-select answer", () => {
    // Up/Down on single-select should treat the highlighted option as the
    // committed answer (highlight = selection), so a prompt-flush mid-flow
    // includes it without requiring Enter first.
    const accumulated = commitActiveAnswer(singleSelect, 1, new Set(), {});
    expect(accumulated).toEqual({
      "Which environment should I deploy to?": ["production"],
    });
  });

  test("commitActiveAnswer is a no-op for single-select with NO_HIGHLIGHT", () => {
    // Default state. The user has not yet pressed Up/Down so there is no
    // implicit selection; the accumulated map must not gain a stale entry.
    const before = { other: ["foo"] };
    expect(commitActiveAnswer(singleSelect, NO_HIGHLIGHT, new Set(), before)).toBe(before);
  });

  test("commitActiveAnswer overwrites prior accumulated values for the same question", () => {
    const before = {
      "Which test suites should run before promotion?": ["unit"],
    };
    const after = commitActiveAnswer(multiSelect, 0, new Set([1]), before);
    expect(after).toEqual({
      "Which test suites should run before promotion?": ["integration"],
    });
    expect(before).toEqual({
      "Which test suites should run before promotion?": ["unit"],
    });
  });

  test("commitActiveAnswer preserves answers for other questions", () => {
    const before = { "Pick env": ["staging"] };
    const after = commitActiveAnswer(multiSelect, 0, new Set([0]), before);
    expect(after).toEqual({
      "Pick env": ["staging"],
      "Which test suites should run before promotion?": ["unit"],
    });
  });

  test("commitActiveAnswer returns the input map when no question is active", () => {
    const before = { "Pick env": ["staging"] };
    expect(commitActiveAnswer(undefined, 0, new Set(), before)).toBe(before);
  });

  test("restoreSavedAnswer reconstructs multi-select checks from saved labels", () => {
    const restored = restoreSavedAnswer(multiSelect, {
      "Which test suites should run before promotion?": ["e2e", "unit"],
    });
    // Multi-select highlight always starts cleared on revisit; toggles
    // restore so the user sees their prior `[x]` boxes.
    expect(restored.selectedIndex).toBe(NO_HIGHLIGHT);
    expect([...restored.checked].sort()).toEqual([0, 2]);
  });

  test("restoreSavedAnswer reconstructs single-select highlight from saved label", () => {
    const restored = restoreSavedAnswer(singleSelect, {
      "Which environment should I deploy to?": ["production"],
    });
    expect(restored.selectedIndex).toBe(1);
    expect(restored.checked.size).toBe(0);
  });

  test("restoreSavedAnswer falls back to NO_HIGHLIGHT when no answer was saved", () => {
    // First visit to a question: nothing highlighted, nothing checked.
    expect(restoreSavedAnswer(singleSelect, {})).toEqual({
      selectedIndex: NO_HIGHLIGHT,
      checked: new Set<number>(),
    });
    expect(restoreSavedAnswer(multiSelect, {})).toEqual({
      selectedIndex: NO_HIGHLIGHT,
      checked: new Set<number>(),
    });
    expect(restoreSavedAnswer(undefined, {})).toEqual({
      selectedIndex: NO_HIGHLIGHT,
      checked: new Set<number>(),
    });
  });

  test("wraps full question option descriptions without truncating", () => {
    expect(
      formatQuestionOptionDescription(
        "Deploy to staging first so the team can validate smoke tests before promoting the release to production after the rollout checklist is complete.",
      ),
    ).toBe(
      "Deploy to staging first so the team can validate smoke tests before\npromoting the release to production after the rollout checklist is\ncomplete.",
    );
  });
});

describe("CLI upgrade package manager detection", () => {
  test("detects an npm global install even when the CLI runs under Bun", () => {
    expect(
      detectPackageManagerFromContext({
        runtimeExecutable: "/Users/david/.bun/bin/bun",
        cliFilePath:
          "/Users/david/.nvm/versions/node/v24.14.0/lib/node_modules/@dzhng/duet-agent/dist/src/cli.js",
        scriptPath: "/Users/david/.nvm/versions/node/v24.14.0/bin/duet",
      }),
    ).toBe("npm");
  });

  test("detects a Bun global install from the package location", () => {
    expect(
      detectPackageManagerFromContext({
        runtimeExecutable: "/Users/david/.bun/bin/bun",
        cliFilePath:
          "/Users/david/.bun/install/global/node_modules/@dzhng/duet-agent/dist/src/cli.js",
        scriptPath: "/Users/david/.bun/bin/duet",
      }),
    ).toBe("bun");
  });

  test("lets package-manager user agents override install path detection", () => {
    expect(
      detectPackageManagerFromContext({
        userAgent: "pnpm/10.0.0 npm/? node/v24.0.0 darwin arm64",
        cliFilePath:
          "/Users/david/.nvm/versions/node/v24.14.0/lib/node_modules/@dzhng/duet-agent/dist/src/cli.js",
      }),
    ).toBe("pnpm");
  });

  test("installs an exact version instead of the latest dist-tag", () => {
    expect(globalUpgradeCommand("npm", "@duetso/agent", "0.1.22")).toEqual([
      "npm",
      "install",
      "--global",
      "@duetso/agent@0.1.22",
    ]);
    expect(globalUpgradeCommand("bun", "@duetso/agent", "v0.1.22")).toEqual([
      "bun",
      "add",
      "--global",
      "@duetso/agent@0.1.22",
    ]);
  });
});
