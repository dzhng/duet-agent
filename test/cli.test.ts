import { afterEach, describe, expect, test } from "bun:test";
import {
  compareSemverVersions,
  detectPackageManagerFromContext,
  formatNewVersionNotice,
  inferDefaultModelName,
  resolveCliMemoryModel,
  resolveCliMemoryModelName,
  resolveCliModelName,
} from "../src/cli.js";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AI_GATEWAY_API_KEY",
  "DUET_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();

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

function clearModelEnv(): void {
  for (const key of MODEL_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("CLI model inference", () => {
  test("prefers Anthropic credentials for the default Opus model", () => {
    clearModelEnv();
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(inferDefaultModelName()).toBe("anthropic:claude-opus-4-7");
  });

  test("uses Duet sandbox credentials when only DUET_API_KEY is set", () => {
    // Bare DUET_API_KEY should route through the duet-gateway provider rather
    // than Vercel's gateway directly. The CLI startup shim copies the token
    // into AI_GATEWAY_API_KEY so the underlying vercel-ai-gateway auth path
    // resolves — without the priority ordering this test guards, that shim
    // would silently downgrade the inference to vercel-ai-gateway.
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_test";

    expect(inferDefaultModelName()).toBe("duet-gateway:anthropic/claude-opus-4.7");
  });

  test("uses AI Gateway credentials for Opus when Anthropic and Duet are absent", () => {
    clearModelEnv();
    process.env.AI_GATEWAY_API_KEY = "test-gateway";

    expect(inferDefaultModelName()).toBe("vercel-ai-gateway:anthropic/claude-opus-4.7");
  });

  test("uses OpenRouter credentials for Opus when Anthropic and AI Gateway are absent", () => {
    clearModelEnv();
    process.env.OPENROUTER_API_KEY = "test-openrouter";
    process.env.OPENAI_API_KEY = "test-openai";

    expect(inferDefaultModelName()).toBe("openrouter:anthropic/claude-opus-4.7");
  });

  test("uses OpenAI credentials when higher-priority providers are absent", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";

    expect(inferDefaultModelName()).toBe("openai:gpt-5.5");
  });

  test("leaves model unset when no supported provider credentials exist", () => {
    clearModelEnv();

    expect(inferDefaultModelName()).toBeUndefined();
  });

  test("falls back to the built-in default when no model or provider key is configured", () => {
    clearModelEnv();

    expect(resolveCliModelName(undefined)).toBe("anthropic:claude-opus-4-7");
  });

  test("keeps an explicitly provided model", () => {
    clearModelEnv();

    expect(resolveCliModelName("openai:gpt-5.5")).toBe("openai:gpt-5.5");
  });

  test("infers default memory from Duet gateway credentials", () => {
    clearModelEnv();
    process.env.DUET_API_KEY = "duet_gt_test";

    expect(resolveCliMemoryModelName(undefined)).toBe("duet-gateway:anthropic/claude-sonnet-4.6");
    expect(resolveCliMemoryModel(undefined)).toEqual({
      modelName: "duet-gateway:anthropic/claude-sonnet-4.6",
      source: "inferred",
      envVar: "DUET_API_KEY",
      fromDotenv: false,
    });
  });

  test("infers default memory from OpenAI credentials", () => {
    clearModelEnv();
    process.env.OPENAI_API_KEY = "test-openai";

    expect(resolveCliMemoryModelName(undefined)).toBe("openai:gpt-5.4-mini");
  });

  test("uses the Anthropic memory default when no provider credentials exist", () => {
    clearModelEnv();

    expect(resolveCliMemoryModelName(undefined)).toBe("anthropic:claude-sonnet-4-6");
  });

  test("keeps an explicitly provided memory model", () => {
    expect(resolveCliMemoryModelName("anthropic:claude-3-5-haiku-latest")).toBe(
      "anthropic:claude-3-5-haiku-latest",
    );
  });
});

describe("CLI version checks", () => {
  test("formats the update notice for stderr and TUI display", () => {
    expect(formatNewVersionNotice("0.1.2", "0.1.3")).toBe(
      "Update available: @dzhng/duet-agent 0.1.2 -> 0.1.3. Run: duet upgrade",
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
});
