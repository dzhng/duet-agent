import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import type { TurnRunnerConfig } from "../src/types/config.js";
import { testIfDocker } from "./helpers/docker-only.js";

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
  testIfDocker("picks up skills added after ensureLoaded()", async () => {
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

  testIfDocker("concurrent ensureLoaded() callers share one discovery", async () => {
    const counterPath = join(tempDir, "runs");
    writeFileSync(counterPath, "");
    const ctx = new SkillContext({
      skills: [explicitSkill(`Use when !\`printf x >> ${counterPath}; printf ready\`.`)],
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    });

    await Promise.all([ctx.ensureLoaded(), ctx.ensureLoaded()]);

    // A second load would re-run every skill's description command, so the
    // counter — not just the merged skill list — is what proves single-flight.
    expect(readFileSync(counterPath, "utf-8")).toBe("x");
    expect(ctx.getSkills()[0]?.description).toBe("Use when ready.");
  });

  testIfDocker("a reload racing an in-flight load lands on the newer snapshot", async () => {
    const config: TurnRunnerConfig = {
      skills: [explicitSkill("Use when !`sleep 1; printf slow`.")],
      skillDiscovery: { includeDefaults: false, cwd: tempDir, skillPaths: [skillsDir] },
    };
    const ctx = new SkillContext(config);

    // `load()` reads config.skills synchronously, so the in-flight load is
    // pinned to the 1s description while the reload gets the instant one.
    // Unqueued, the reload would settle first and the older, beta-less
    // snapshot would assign last and silently win.
    const loading = ctx.ensureLoaded();
    config.skills = [explicitSkill("Use when !`printf fast`.")];
    installSkill("beta", "second skill");
    await Promise.all([loading, ctx.reload()]);

    expect(ctx.getSkills().map((s) => s.name)).toContain("beta");
    expect(ctx.getSkills()[0]?.description).toBe("Use when fast.");
  });
});

function explicitSkill(description: string): Skill {
  return {
    name: "explicit",
    description,
    filePath: join(tempDir, "explicit.md"),
    baseDir: tempDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
}
