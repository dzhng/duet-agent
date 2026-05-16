import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import { discoverInstalledSkills, resolveSkillScope } from "../src/turn-runner/skills.js";
import { createTurnRunnerTools } from "../src/turn-runner/tools.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "built-in-skills-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("built-in skills surface through discovery", () => {
  test("discoverInstalledSkills includes /relay with builtin scope", () => {
    const { skills } = discoverInstalledSkills(tempDir);
    const relay = skills.find((s) => s.name === "relay");
    expect(relay).toBeDefined();
    expect(resolveSkillScope(relay!, tempDir)).toBe("builtin");
  });

  test("SkillContext appends the relay skill block when /relay is in the prompt", async () => {
    const ctx = new SkillContext({
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("monitor the inbox /relay every hour");

    // Token stays in the prompt verbatim.
    expect(resolved).toContain("monitor the inbox /relay every hour");
    // Skill block was injected with the relay instructions.
    expect(resolved).toContain('<skill name="relay">');
    expect(resolved).toContain("state-machine tools");
    expect(resolved).toContain("</skill>");
    // The legacy `<system-reminder>` wrapper is gone — the body must not
    // smuggle one in.
    expect(resolved).not.toContain("<system-reminder>");
  });

  test("read_skill returns the inline body for a built-in skill", async () => {
    // Drive through the same factory the runner uses, so we exercise the
    // exact tool wiring callers see — not the internal readSkillInstructions
    // helper.
    const { skills } = discoverInstalledSkills(tempDir);
    const tools = createTurnRunnerTools({
      cwd: tempDir,
      mode: "agent",
      skills,
      todoStorage: { getTodos: () => [], setTodos: () => {} },
    });
    const readSkillTool = tools.find((tool) => tool.name === "read_skill");
    expect(readSkillTool).toBeDefined();

    const relay = skills.find((s) => s.name === "relay")!;
    const result = await readSkillTool!.execute("tool-1", { name: "relay" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    // Header carries the synthetic built-in path so callers know where
    // sibling files would live (there aren't any for built-ins, but the
    // shape stays uniform with disk-resident skills).
    expect(text).toContain("Skill: relay");
    expect(text).toContain(`Path: ${relay.filePath}`);
    // Body is the inline RELAY_INSTRUCTIONS, not a disk read.
    expect(text).toContain("state-machine tools");
    expect(result.details).toEqual({
      type: "read_skill",
      name: "relay",
      filePath: relay.filePath,
    });
  });

  test("a user-installed skill named 'relay' shadows the built-in", async () => {
    const ctx = new SkillContext({
      skills: [
        {
          name: "relay",
          description: "user override",
          filePath: `${tempDir}/SKILL.md`,
          baseDir: tempDir,
          sourceInfo: {
            path: tempDir,
            source: "test",
            scope: "temporary",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();
    const found = ctx.getSkills().filter((s) => s.name === "relay");
    expect(found).toHaveLength(1);
    expect(found[0]!.description).toBe("user override");
  });
});
