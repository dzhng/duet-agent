import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SkillContext } from "../src/turn-runner/skill-context.js";

let tempDir: string;
let skillsDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-context-reload-"));
  skillsDir = join(tempDir, ".duet", "skills");
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function installSkill(name: string, description: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  // Skill loader requires frontmatter with name + description.
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe("SkillContext.reload", () => {
  test("picks up skills added after ensureLoaded()", async () => {
    installSkill("alpha", "first skill");
    const ctx = new SkillContext({
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    });
    await ctx.ensureLoaded();
    expect(ctx.getSkills().some((s) => s.name === "alpha")).toBe(true);
    expect(ctx.getSkills().some((s) => s.name === "beta")).toBe(false);

    installSkill("beta", "second skill");
    // ensureLoaded is a no-op after first run — only reload re-discovers.
    await ctx.ensureLoaded();
    expect(ctx.getSkills().some((s) => s.name === "beta")).toBe(false);

    await ctx.reload();
    const names = ctx.getSkills().map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });
});
