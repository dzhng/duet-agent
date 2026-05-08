import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  cliEnvFilePaths,
  compareSemverVersions,
  detectPackageManagerFromContext,
  formatEnvEntries,
  formatNewVersionNotice,
  globalUpgradeCommand,
  loadCliEnvFiles,
  parseResumeHistoryLines,
  runEnvCommand,
} from "../src/cli.js";
import { resolveCliMemoryModel, resolveCliModel } from "../src/model-resolution/index.js";
import {
  activeSkillAutocompleteToken,
  formatSkillAutocompleteDescription,
  formatSkillAutocompleteItem,
  historyDisplayBlocks,
  limitHistoryDisplayBlocks,
  moveSkillAutocompleteSelection,
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
      modelName: "duet-gateway:anthropic/claude-opus-4.7",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "duet-gateway:anthropic/claude-haiku-4.5",
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
      modelName: "vercel-ai-gateway:anthropic/claude-opus-4.7",
      source: "inferred",
      envVar: "AI_GATEWAY_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "vercel-ai-gateway:anthropic/claude-haiku-4.5",
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
      modelName: "openrouter:anthropic/claude-opus-4.7",
      source: "inferred",
      envVar: "OPENROUTER_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "openrouter:anthropic/claude-haiku-4.5",
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
      modelName: "anthropic:claude-opus-4-7",
      source: "inferred",
      envVar: "ANTHROPIC_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "anthropic:claude-haiku-4-5",
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
      modelName: "duet-gateway:anthropic/claude-opus-4.7",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "duet-gateway:anthropic/claude-haiku-4.5",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
  });

  test("uses OpenAI credentials when higher-priority providers are absent", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "openai:gpt-5.5",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "openai:gpt-5.4-mini",
      source: "inferred",
      envVar: "OPENAI_API_KEY",
      fromDotenv: false,
    });
  });

  test("falls back to built-in model defaults when no supported provider credentials exist", () => {
    clearModelEnv();

    expect(resolveCliModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "anthropic:claude-opus-4-7",
      source: "default",
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "anthropic:claude-haiku-4-5",
      source: "default",
    });
  });

  test("keeps an explicitly provided model", () => {
    clearModelEnv();

    expect(resolveCliModel("openai:gpt-5.5", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "openai:gpt-5.5",
      source: "explicit",
    });
  });

  test("keeps an explicitly provided memory model", () => {
    expect(resolveCliMemoryModel("anthropic:claude-3-5-haiku-latest", EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "anthropic:claude-3-5-haiku-latest",
      source: "explicit",
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
  test("formats the update notice for stderr and TUI display", () => {
    expect(formatNewVersionNotice("@duetso/agent", "0.1.2", "0.1.3")).toBe(
      "Update available: @duetso/agent 0.1.2 -> 0.1.3. Run: duet upgrade",
    );
  });

  test("compares semantic versions", () => {
    expect(compareSemverVersions("0.1.3", "0.1.2")).toBe(1);
    expect(compareSemverVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareSemverVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });
});

describe("CLI resume history display", () => {
  test("parses non-negative resume history line limits", () => {
    expect(parseResumeHistoryLines("0")).toBe(0);
    expect(parseResumeHistoryLines("40")).toBe(40);
    expect(() => parseResumeHistoryLines("-1")).toThrow(
      "--resume-history-lines must be a non-negative integer",
    );
    expect(() => parseResumeHistoryLines("all")).toThrow(
      "--resume-history-lines must be a non-negative integer",
    );
  });

  test("limits resumed history to the newest display lines", () => {
    const limited = limitHistoryDisplayBlocks(
      [
        { kind: "user", content: "you:\nold question" },
        { kind: "agent", content: "old answer" },
        { kind: "user", content: "you:\nnew question" },
        { kind: "agent", content: "line one\nline two\nline three" },
      ],
      4,
    );

    expect(limited.omittedLines).toBe(4);
    expect(limited.blocks.map((block) => block.content)).toEqual([
      "new question",
      "line one\nline two\nline three",
    ]);
  });

  test("zero resume history lines disables replay", () => {
    const limited = limitHistoryDisplayBlocks([{ kind: "agent", content: "one\ntwo" }], 0);

    expect(limited.blocks).toEqual([]);
    expect(limited.omittedLines).toBe(2);
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
      modelName: "anthropic:claude-opus-4-7",
      modelSource: "default",
      memoryModelName: "anthropic:claude-haiku-4-5",
    });
    const history = limitHistoryDisplayBlocks([{ kind: "agent", content: "previous answer" }], 40);

    expect([...header, ...history.blocks.map((block) => block.content)]).toEqual([
      "[duet] v0.1.12",
      "[cwd] /repo",
      "[session] session_123",
      "[model] anthropic:claude-opus-4-7 — default",
      "[memory model] anthropic:claude-haiku-4-5",
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
