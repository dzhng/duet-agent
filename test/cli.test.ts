import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildCliTurnConfig,
  cliEnvFilePaths,
  compareSemverVersions,
  detectPackageManagerFromContext,
  expandHomeDir,
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
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
  moveQuestionHighlight,
  moveSkillAutocompleteSelection,
  NO_HIGHLIGHT,
  questionPickerAnswer,
  replaceFileAutocompleteToken,
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
      modelName: "opus-4.8",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
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
      modelName: "opus-4.8",
      source: "inferred",
      envVar: "AI_GATEWAY_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
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
      modelName: "opus-4.8",
      source: "inferred",
      envVar: "OPENROUTER_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
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
      modelName: "opus-4.8",
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
      modelName: "opus-4.8",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
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
      modelName: "opus-4.8",
      source: "default",
    });
    expect(resolveCliMemoryModel(undefined, EMPTY_DOTENV_KEYS)).toEqual({
      modelName: "gpt-5.4-mini",
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
    expect(pinnedDefaultModel("anthropic")).toBe("anthropic:claude-opus-4-8");
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

  test("routes Duet OpenAI models through an OpenAI-compatible API", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    const model = resolveModelName("gpt-5.5");

    expect(model.provider).toBe("duet-gateway");
    expect(model.id).toBe("openai/gpt-5.5");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe("https://duet.so/api/v1/ai-gateway/v1");
    expect(model.reasoning).toBe(true);
  });

  test("clamps deepseek-v4-pro output tokens to the baseten backend limit", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    // pi-ai's catalog advertises 384000, but the gateway routes to baseten,
    // which rejects max_tokens above 262144.
    expect(resolveModelName("deepseek-v4-pro").maxTokens).toBe(262144);
    expect(resolveModelName("vercel:deepseek/deepseek-v4-pro").maxTokens).toBe(262144);
  });

  test("leaves output tokens untouched for models within the backend limit", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    // glm-4.7's catalog maxTokens (40000) is already under any backend cap, so
    // resolution must not alter it.
    expect(resolveModelName("glm-4.7").maxTokens).toBe(40000);
  });

  test("resolves the glm-5.2 shorthand through the duet gateway", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    expect(resolveModelName("glm-5.2").id).toBe("zai/glm-5.2");
    expect(resolveModelName("duet:zai/glm-5.2").id).toBe("zai/glm-5.2");
  });

  test("synthesizes a pass-through model for gateway ids absent from the catalog", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    // The duet gateway proxies Vercel's AI Gateway, so a model id the pinned
    // pi-ai catalog has not shipped yet must still resolve (over the
    // anthropic-messages transport) rather than throwing "Unknown duet-gateway
    // model" — new gateway models work without a catalog/code change here.
    const synthesized = resolveModelName("duet:zai/glm-9.9-not-in-catalog");
    expect(synthesized.id).toBe("zai/glm-9.9-not-in-catalog");
    expect(synthesized.provider).toBe("duet-gateway");
    expect(synthesized.api).toBe("anthropic-messages");

    // OpenAI-prefixed ids keep the openai-responses transport so reasoning
    // stream semantics survive, and route through the gateway's /v1 path.
    const synthesizedOpenAI = resolveModelName("duet:openai/gpt-future");
    expect(synthesizedOpenAI.api).toBe("openai-responses");
    expect(synthesizedOpenAI.baseUrl.endsWith("/v1")).toBe(true);
  });

  test("forwards a provider-pinned id that is absent from the catalog without throwing", () => {
    clearModelEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    // pi-ai returns undefined for catalog-absent ids; resolution must pass the
    // model through (the id is sent to the provider at request time) rather than
    // dereference a missing model while clamping output tokens.
    expect(() => resolveModelName("anthropic:claude-sonnet-5-1")).not.toThrow();
  });

  test("resolveProviderApiKey maps the project-local duet-gateway provider to DUET_API_KEY", async () => {
    const { resolveProviderApiKey } = await import("../src/model-resolution/duet-gateway.js");
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";
    // pi-ai's built-in env-key map does not know `duet-gateway`, so
    // without this shim every live-model eval that authenticates via
    // `DUET_API_KEY` alone would silently send an empty API key and
    // fail with `Could not resolve authentication method`.
    expect(resolveProviderApiKey("duet-gateway")).toBe("test-duet");
  });

  test("resolveProviderApiKey falls through to pi-ai env-key resolution for other providers", async () => {
    const { resolveProviderApiKey } = await import("../src/model-resolution/duet-gateway.js");
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    expect(resolveProviderApiKey("vercel-ai-gateway")).toBe("test-gateway");
    expect(resolveProviderApiKey("anthropic")).toBe("test-anthropic");
  });

  test("resolving a duet-gateway model does not clobber an existing AI_GATEWAY_API_KEY", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_x";
    process.env.AI_GATEWAY_API_KEY = "vck_real_vercel_key";

    // Authoring a duet-gateway model used to overwrite AI_GATEWAY_API_KEY as
    // a side effect (forceDuetGatewayAuth), which silently destroyed a real
    // Vercel key the user might still need for an explicit
    // `vercel-ai-gateway:*` pin later in the same process. Per-call auth now
    // flows through resolveProviderApiKey, so resolution must be a pure
    // env-read.
    resolveModelName("opus-4.7");

    expect(process.env.AI_GATEWAY_API_KEY).toBe("vck_real_vercel_key");
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

  test("provider shorthand in provider:modelId form canonicalizes the provider", () => {
    clearModelEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveModelName("claude:claude-opus-4-7").id).toBe("claude-opus-4-7");
    expect(resolveModelName("gpt:gpt-5.5").id).toBe("gpt-5.5");
  });

  test("duet provider shorthand resolves through the duet gateway", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    const fromCanonical = resolveModelName("duet-gateway:anthropic/claude-opus-4.7");
    const fromShorthand = resolveModelName("duet:anthropic/claude-opus-4.7");

    expect(fromShorthand.id).toBe(fromCanonical.id);
    expect(fromShorthand.baseUrl).toBe(fromCanonical.baseUrl);
  });

  test("canonicalizes dashed model id aliases inside provider:modelId form", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";
    process.env.AI_GATEWAY_API_KEY = "test-gateway";

    // The duet gateway proxies vercel-ai-gateway's catalog, which spells the
    // id with a dot. Users frequently type dashes; the alias table should
    // bridge the gap on both providers.
    expect(resolveModelName("duet:anthropic/claude-opus-4-7").id).toBe("anthropic/claude-opus-4.7");
    expect(resolveModelName("vercel:anthropic/claude-sonnet-4-6").id).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });

  test("leaves provider:modelId untouched when the native id uses dashes", () => {
    clearModelEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    // Anthropic's own API uses dashes, so the dashed alias must map back to
    // the dashed id rather than the gateway's dotted variant.
    expect(resolveModelName("anthropic:claude-opus-4.7").id).toBe("claude-opus-4-7");
    expect(resolveModelName("anthropic:claude-opus-4-7").id).toBe("claude-opus-4-7");
  });

  test("passes provider:modelId through unchanged when no alias matches", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "test-duet";

    // No catalog alias for this id, so the duet-gateway lookup falls through
    // to the underlying vercel-ai-gateway model definition without rewriting.
    expect(resolveModelName("duet:anthropic/claude-opus-4.7").id).toBe("anthropic/claude-opus-4.7");
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

describe("expandHomeDir", () => {
  // Covers the `--workdir ~/xyz` path in both run.ts and rpc.ts so a quoted
  // tilde (which the shell does not expand) still resolves to the user's
  // home directory.
  test("expands a leading ~ to the user's home directory", () => {
    const home = homedir();
    expect(expandHomeDir("~")).toBe(home);
    expect(expandHomeDir("~/code/foo")).toBe(join(home, "code/foo"));
  });

  test("leaves non-tilde paths unchanged so relative workdirs still work", () => {
    expect(expandHomeDir("/abs/path")).toBe("/abs/path");
    expect(expandHomeDir("relative/path")).toBe("relative/path");
    expect(expandHomeDir("")).toBe("");
    // `~user` is intentionally not expanded — Node has no portable helper for
    // resolving another user's home, and shells already expand the supported
    // forms before duet sees them.
    expect(expandHomeDir("~other/foo")).toBe("~other/foo");
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

  test("preserves --db when an explicit memory db path was set", () => {
    expect(
      resumeCommand("session_123", {
        workDir: "/repo",
        dbPath: "/tmp/custom.db",
      }),
    ).toContain("--db /tmp/custom.db");
  });
});

describe("CLI memory db resolution", () => {
  test("defaults memoryDbPath to ~/.duet/memory.db when neither --db nor --incognito is set", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";
    const { config } = buildCliTurnConfig({ workDir: "/repo" }, EMPTY_DOTENV_KEYS);
    expect(typeof config.memoryDbPath).toBe("string");
    expect(config.memoryDbPath as string).toMatch(/\.duet\/memory\.db$/);
  });

  test("forwards --db verbatim", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";
    const { config } = buildCliTurnConfig(
      { workDir: "/repo", dbPath: "/tmp/custom.db" },
      EMPTY_DOTENV_KEYS,
    );
    expect(config.memoryDbPath).toBe("/tmp/custom.db");
  });

  test("--incognito wins over --db", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";
    const { config } = buildCliTurnConfig(
      { workDir: "/repo", dbPath: "/tmp/custom.db", incognito: true },
      EMPTY_DOTENV_KEYS,
    );
    expect(config.memoryDbPath).toBe(false);
  });
});

describe("CLI render mode", () => {
  test("uses TUI only for interactive sessions without a prompt", () => {
    expect(shouldUseTui({ interactive: true })).toBe(true);
    expect(shouldUseTui({ interactive: true, prompt: "hi" })).toBe(false);
    expect(shouldUseTui({ interactive: false, prompt: "hi" })).toBe(false);
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

  test("locates the active slash token under the cursor", () => {
    const text = "please /rev now";
    const token = activeSkillAutocompleteToken(text, "please /rev".length);
    if (!token) throw new Error("Expected slash token");

    expect(token).toEqual({ start: 7, end: 11, query: "rev" });
  });
});

describe("TUI file autocomplete helpers", () => {
  test("replaceFileAutocompleteToken inserts a markdown link with `./` prefix", () => {
    const text = "look at @sr now";
    const token = activeFileAutocompleteToken(text, "look at @sr".length);
    if (!token) throw new Error("Expected file token");

    expect(token).toEqual({ start: 8, end: 11, query: "sr" });
    expect(replaceFileAutocompleteToken(text, token, "src/tui/app.ts")).toEqual({
      text: "look at [@app.ts](./src/tui/app.ts) now",
      cursorOffset: "look at [@app.ts](./src/tui/app.ts)".length,
    });
  });

  test("replaceFileAutocompleteToken inserts a trailing space when none follows", () => {
    const text = "diff @";
    const token = activeFileAutocompleteToken(text, text.length);
    if (!token) throw new Error("Expected file token");

    const replacement = replaceFileAutocompleteToken(text, token, "README.md");
    expect(replacement.text).toBe("diff [@README.md](./README.md) ");
    expect(replacement.cursorOffset).toBe(replacement.text.length);
  });

  test("replaceFileAutocompleteToken uses the basename in the visible label", () => {
    const text = "@p";
    const token = activeFileAutocompleteToken(text, text.length);
    if (!token) throw new Error("Expected file token");

    expect(
      replaceFileAutocompleteToken(text, token, "packages/agent-gateway/src/index.ts").text,
    ).toBe("[@index.ts](./packages/agent-gateway/src/index.ts) ");
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
    // Default state when the user has not yet pressed Up/Down. Returning
    // undefined lets the picker orchestration skip writing an answer the
    // user hasn't expressed yet.
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
