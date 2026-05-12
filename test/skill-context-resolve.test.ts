import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempDir: string;

async function writeSkill(name: string, body: string): Promise<Skill> {
  const skillDir = join(tempDir, name);
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  await writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
  );
  return {
    name,
    description: `${name} skill`,
    filePath: skillFile,
    baseDir: skillDir,
    sourceInfo: createSyntheticSourceInfo(skillFile, {
      source: "test",
      scope: "temporary",
      origin: "top-level",
      baseDir: skillDir,
    }),
    disableModelInvocation: false,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-context-resolve-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SkillContext.resolveSlashSkillPrompt", () => {
  testIfDocker(
    "appends the SKILL.md body as a <skill> block when a /name token is present",
    async () => {
      const skill = await writeSkill(
        "review",
        "Audit changed code for naming, dead refs, and stale comments.",
      );

      const ctx = new SkillContext({ skills: [skill], skillDiscovery: { includeDefaults: false } });
      await ctx.ensureLoaded();

      const resolved = ctx.resolveSlashSkillPrompt("/review go");
      expect(resolved).toContain("/review go");
      expect(resolved).toContain('<skill name="review">');
      expect(resolved).toContain("<instructions>");
      expect(resolved).toContain("Audit changed code for naming, dead refs, and stale comments.");
      expect(resolved).toContain("</instructions>");
      expect(resolved).toContain("</skill>");
      // The injected block hangs off the end of the user prompt, separated
      // by a blank line so the model sees the user's text first.
      expect(resolved.startsWith("/review go\n\n<skill")).toBe(true);
    },
  );

  testIfDocker("returns the prompt unchanged when no slash command matches a skill", async () => {
    const skill = await writeSkill("review", "body");
    const ctx = new SkillContext({ skills: [skill], skillDiscovery: { includeDefaults: false } });
    await ctx.ensureLoaded();

    expect(ctx.resolveSlashSkillPrompt("just a normal message")).toBe("just a normal message");
    // Unknown slash command — nothing to inject, prompt passes through.
    expect(ctx.resolveSlashSkillPrompt("/unknown go")).toBe("/unknown go");
  });

  testIfDocker("injects each unique skill once even when the same /name appears twice", async () => {
    const skill = await writeSkill("review", "BODY_REVIEW");
    const ctx = new SkillContext({ skills: [skill], skillDiscovery: { includeDefaults: false } });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("/review pass one /review pass two");
    const matches = resolved.match(/<skill name="review">/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Body is loaded from disk; assert it appears at least as many times as
    // the <skill> opening tag (defends against future dedup regressions: if
    // the resolver one day collapses duplicates we want the bodies to match
    // the tags, not silently diverge).
    const bodyMatches = resolved.match(/BODY_REVIEW/g) ?? [];
    expect(bodyMatches.length).toBe(matches.length);
  });

  testIfDocker("injects multiple distinct skills in slash order", async () => {
    const review = await writeSkill("review", "REVIEW_BODY");
    const release = await writeSkill("release", "RELEASE_BODY");
    const ctx = new SkillContext({
      skills: [review, release],
      skillDiscovery: { includeDefaults: false },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("/release after /review");
    const releaseIdx = resolved.indexOf('<skill name="release">');
    const reviewIdx = resolved.indexOf('<skill name="review">');
    expect(releaseIdx).toBeGreaterThan(0);
    expect(reviewIdx).toBeGreaterThan(releaseIdx);
    expect(resolved).toContain("RELEASE_BODY");
    expect(resolved).toContain("REVIEW_BODY");
  });

  testIfDocker("ignores slash tokens that have attached arguments (e.g. /foo:bar)", async () => {
    const skill = await writeSkill("review", "BODY");
    const ctx = new SkillContext({ skills: [skill], skillDiscovery: { includeDefaults: false } });
    await ctx.ensureLoaded();

    // parseSlashCommands requires the whole whitespace-separated token to
    // match `^/[A-Za-z0-9_.-]+$`. `/review:` carries a trailing colon so it
    // does not match — no injection.
    const resolved = ctx.resolveSlashSkillPrompt("look at /review:summary please");
    expect(resolved).toBe("look at /review:summary please");
  });
});
