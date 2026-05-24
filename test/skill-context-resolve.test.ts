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
  await writeFile(skillFile, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
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
      expect(resolved).toContain('<skill name="review"');
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

  testIfDocker(
    "injects each unique skill once even when the same /name appears twice",
    async () => {
      const skill = await writeSkill("review", "BODY_REVIEW");
      const ctx = new SkillContext({ skills: [skill], skillDiscovery: { includeDefaults: false } });
      await ctx.ensureLoaded();

      const resolved = ctx.resolveSlashSkillPrompt("/review pass one /review pass two");
      const matches = resolved.match(/<skill name="review"/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(1);
      // Body is loaded from disk; assert it appears at least as many times as
      // the <skill> opening tag (defends against future dedup regressions: if
      // the resolver one day collapses duplicates we want the bodies to match
      // the tags, not silently diverge).
      const bodyMatches = resolved.match(/BODY_REVIEW/g) ?? [];
      expect(bodyMatches.length).toBe(matches.length);
    },
  );

  testIfDocker("injects multiple distinct skills in slash order", async () => {
    const review = await writeSkill("review", "REVIEW_BODY");
    const release = await writeSkill("release", "RELEASE_BODY");
    const ctx = new SkillContext({
      skills: [review, release],
      skillDiscovery: { includeDefaults: false },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("/release after /review");
    const releaseIdx = resolved.indexOf('<skill name="release"');
    const reviewIdx = resolved.indexOf('<skill name="review"');
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

  // Regression: a real Duet user message starting with `/review` followed by
  // newlines and free-form prompt text. Locks in that the resolver wraps
  // the SKILL.md body in the expected XML envelope:
  //   <skill name="review">
  //     <instructions>...SKILL.md body...</instructions>
  //   </skill>
  // and appends it after the user's original prompt verbatim.
  testIfDocker(
    "wraps the SKILL.md body in <skill><instructions> XML for a real `/review` user message",
    async () => {
      const skillBody = "Audit changed code for naming, dead refs, and stale comments.";
      const skill = await writeSkill("review", skillBody);

      const ctx = new SkillContext({
        skills: [skill],
        skillDiscovery: { includeDefaults: false },
      });
      await ctx.ensureLoaded();

      const userPrompt =
        "/review\n\nplus also review the changes - does it resolve with the xml tags?";
      const resolved = ctx.resolveSlashSkillPrompt(userPrompt);

      // Original user prompt preserved verbatim at the head.
      expect(resolved.startsWith(userPrompt)).toBe(true);

      // Full XML envelope present, with the SKILL.md body inside <instructions>.
      expect(resolved).toContain('<skill name="review"');
      expect(resolved).toContain("<instructions>");
      expect(resolved).toContain(skillBody);
      expect(resolved).toContain("</instructions>");
      expect(resolved).toContain("</skill>");

      // Tag ordering: opening <skill> before <instructions> before body
      // before </instructions> before </skill>.
      const skillOpen = resolved.indexOf('<skill name="review"');
      const instrOpen = resolved.indexOf("<instructions>", skillOpen);
      const bodyAt = resolved.indexOf(skillBody, instrOpen);
      const instrClose = resolved.indexOf("</instructions>", bodyAt);
      const skillClose = resolved.indexOf("</skill>", instrClose);
      expect(skillOpen).toBeGreaterThan(-1);
      expect(instrOpen).toBeGreaterThan(skillOpen);
      expect(bodyAt).toBeGreaterThan(instrOpen);
      expect(instrClose).toBeGreaterThan(bodyAt);
      expect(skillClose).toBeGreaterThan(instrClose);

      // Exactly one skill block — no accidental duplicate injection.
      const skillOpenings = resolved.match(/<skill name="/g) ?? [];
      expect(skillOpenings.length).toBe(1);
    },
  );

  // Regression: chat-app's compose-bar `/` skill picker does NOT emit a bare
  // `/review` slash token. It emits a literal self-closing XML tag of the
  // shape `<Skill name="review" path="..." />` into the message markdown,
  // verbatim, with no backend-side expansion (see
  // apps/web/components/chat/compose-bar/primitives/input/features/mention/mention-markdown-codec.ts
  // and apps/mobile/src/lib/markdown.ts). When chat-app sends that message
  // to duet-agent, the runner must still inject the SKILL.md body so the
  // model has skill context. Today `parseSlashCommands` only matches
  // whitespace-separated `/name` tokens, so this case currently no-ops.
  // This test pins the desired behavior so the gap is visible and the
  // resolver can be extended to recognize the `<Skill name="..." />` form.
  testIfDocker(
    "injects the SKILL.md body when the user message contains the chat-app compose-bar `<Skill name=... path=... />` tag",
    async () => {
      const skillBody = "Audit changed code for naming, dead refs, and stale comments.";
      const skill = await writeSkill("review", skillBody);

      const ctx = new SkillContext({
        skills: [skill],
        skillDiscovery: { includeDefaults: false },
      });
      await ctx.ensureLoaded();

      // Literal payload emitted by the chat-app web + mobile compose bars
      // when the user picks the `review` skill from the `/` picker.
      const userPrompt =
        '<Skill name="review" path="/home/app/.duet/skills/review" />\n\nplease review the diff';
      const resolved = ctx.resolveSlashSkillPrompt(userPrompt);

      // Original user prompt preserved verbatim at the head.
      expect(resolved.startsWith(userPrompt)).toBe(true);

      // Skill body must be injected in the same XML envelope used for the
      // bare `/review` slash form, so downstream consumers see one shape.
      expect(resolved).toContain('<skill name="review"');
      expect(resolved).toContain("<instructions>");
      expect(resolved).toContain(skillBody);
      expect(resolved).toContain("</instructions>");
      expect(resolved).toContain("</skill>");

      // Exactly one skill block — the `<Skill .../>` tag in the prompt must
      // not double-resolve into two injected blocks.
      const skillOpenings = resolved.match(/<skill name="/g) ?? [];
      expect(skillOpenings.length).toBe(1);
    },
  );
});
