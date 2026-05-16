import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import {
  BUILT_IN_SKILLS,
  isBuiltInSkill,
  listBuiltInSkills,
} from "../src/turn-runner/built-in-skills.js";
import {
  discoverInstalledSkills,
  readSkillInstructions,
  resolveSkillScope,
} from "../src/turn-runner/skills.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "built-in-skills-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("built-in skills registry", () => {
  test("ships the /relay skill", () => {
    const relay = BUILT_IN_SKILLS.find(({ skill }) => skill.name === "relay");
    expect(relay).toBeDefined();
    expect(relay!.instructions).toContain("state-machine tools");
  });

  test("listBuiltInSkills returns plain Skill records", () => {
    const skills = listBuiltInSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(isBuiltInSkill(skill)).toBe(true);
    }
  });
});

describe("discoverInstalledSkills", () => {
  test("includes built-in skills with builtin scope", () => {
    const { skills } = discoverInstalledSkills(tempDir);
    const relay = skills.find((s) => s.name === "relay");
    expect(relay).toBeDefined();
    expect(resolveSkillScope(relay!, tempDir)).toBe("builtin");
  });
});

describe("readSkillInstructions", () => {
  test("returns inline body for built-in skills without touching disk", () => {
    const relay = listBuiltInSkills().find((s) => s.name === "relay")!;
    const body = readSkillInstructions(relay);
    expect(body).toContain("state-machine tools");
    // No `<system-reminder>` wrapper — the runner wraps the body in a
    // `<skill>` block instead.
    expect(body).not.toContain("<system-reminder>");
  });
});

describe("SkillContext.resolveSlashSkillPrompt with /relay", () => {
  test("appends the built-in relay skill block when /relay is in the prompt", async () => {
    const ctx = new SkillContext({
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("monitor the inbox /relay every hour");

    // Token stays in the prompt verbatim.
    expect(resolved).toContain("monitor the inbox /relay every hour");
    // Skill block was appended.
    expect(resolved).toContain('<skill name="relay">');
    expect(resolved).toContain("state-machine tools");
    expect(resolved).toContain("</skill>");
  });

  test("user-installed skill named 'relay' shadows the built-in", async () => {
    // SkillContext can take explicit skills which take precedence over discovery.
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
