import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCliTurnConfig } from "../src/cli/run.js";
import { parseRpcArgs } from "../src/cli/rpc.js";
import { SkillContext } from "../src/turn-runner/skill-context.js";

let tempDir: string;
let cwdDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-ctx-spf-"));
  cwdDir = await mkdtemp(join(tmpdir(), "skill-ctx-cwd-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await rm(cwdDir, { recursive: true, force: true });
});

describe("SkillContext.getResolvedAgentFiles", () => {
  test("resolves absolute systemPromptFiles paths verbatim", async () => {
    // The agent-gateway writes a session-scoped system-prompt file outside
    // `cwd` and passes its absolute path via --system-prompt-file. A naive
    // `join(cwd, fileName)` would strip the leading slash and silently drop
    // the layer; verify the absolute path is honored as-is.
    const absPath = join(tempDir, "session-prompt.md");
    await writeFile(absPath, "session prompt body");

    const ctx = new SkillContext({
      cwd: cwdDir,
      systemPromptFiles: [absPath],
      skillDiscovery: { includeDefaults: false },
    });

    const resolved = ctx.getResolvedAgentFiles();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.path).toBe(absPath);
    expect(resolved[0]!.name).toBe("session-prompt.md");
  });

  test("still resolves relative systemPromptFiles names against cwd", async () => {
    const relName = "AGENTS.md";
    await writeFile(join(cwdDir, relName), "agents body");

    const ctx = new SkillContext({
      cwd: cwdDir,
      systemPromptFiles: [relName],
      skillDiscovery: { includeDefaults: false },
    });

    const resolved = ctx.getResolvedAgentFiles();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.path).toBe(join(cwdDir, relName));
    expect(resolved[0]!.name).toBe(relName);
  });

  test("silently skips missing files (absolute and relative)", async () => {
    const ctx = new SkillContext({
      cwd: cwdDir,
      systemPromptFiles: [join(tempDir, "missing.md"), "also-missing.md"],
      skillDiscovery: { includeDefaults: false },
    });

    expect(ctx.getResolvedAgentFiles()).toEqual([]);
  });

  test("resolves an absolute --system-prompt-file end-to-end (rpc args → config → SkillContext)", async () => {
    // Mirrors the chat-app agent-gateway wire: the host writes a session
    // system-prompt file outside the runner's workdir and passes its absolute
    // path via --system-prompt-file. Regression guard for the silent-drop bug
    // where `path.join(cwd, absPath)` produced a nonexistent path under cwd.
    const absPath = join(tempDir, "system-prompt.md");
    await writeFile(absPath, "GATEWAY_SYSTEM_PROMPT");

    const parsed = parseRpcArgs([
      "--workdir",
      cwdDir,
      "--system-prompt-file",
      absPath,
      "--incognito",
    ]);
    expect(parsed.systemPromptFiles).toEqual([absPath]);

    const { config } = buildCliTurnConfig(parsed, new Set());
    expect(config.cwd).toBe(cwdDir);
    expect(config.systemPromptFiles).toEqual([absPath]);

    const ctx = new SkillContext({ ...config, skillDiscovery: { includeDefaults: false } });
    const resolved = ctx.getResolvedAgentFiles();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.path).toBe(absPath);
    expect(resolved[0]!.name).toBe("system-prompt.md");
  });
});
