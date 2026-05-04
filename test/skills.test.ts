import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { Harness } from "../src/harness/harness.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { createTestHarness, type TestHarnessApp } from "./helpers/skills-harness.js";

let app: TestHarnessApp | undefined;
let tempDir: string | undefined;

class SkillPromptHarness extends Harness {
  systemPromptForTest(systemPrompt?: string): string {
    return this.createBaseSystemPromptWithAppendedLayers(systemPrompt);
  }
}

afterEach(async () => {
  await app?.cleanup();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  app = undefined;
  tempDir = undefined;
});

describe("Harness skills", () => {
  test("expands bash commands for explicitly provided skills", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const skillPath = join(tempDir, "SKILL.md");
    await writeFile(
      skillPath,
      dedent`
        ---
        name: explicit-skill
        description: Expands command output in skill instructions.
        ---

        # Explicit Skill

        !\`printf 'expanded value'\`
      `,
    );
    const harness = new Harness({
      harnessModel: "anthropic:claude-opus-4-6",
      cwd: process.cwd(),
      skillDiscovery: { includeDefaults: false },
      skills: [
        {
          name: "explicit-skill",
          description: "Expands command output in skill instructions.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    const instructions = harness.getSkillInstructions("explicit-skill");

    expect(instructions).toContain("expanded value");
    expect(instructions).not.toContain("!`printf");
  });

  test("expands bash commands in skill descriptions", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const skillPath = join(tempDir, "SKILL.md");
    await writeFile(
      skillPath,
      dedent`
        ---
        name: description-skill
        description: Use when !\`printf 'description expansion'\`.
        ---

        # Description Skill
      `,
    );
    const harness = new Harness({
      harnessModel: "anthropic:claude-opus-4-6",
      cwd: process.cwd(),
      skillDiscovery: { includeDefaults: false },
      skills: [
        {
          name: "description-skill",
          description: "Use when !`printf 'description expansion'`.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    const [skill] = await harness.getSkills();

    expect(skill?.description).toBe("Use when description expansion.");
  });

  test("injects all loaded skill instructions into the system prompt", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const firstSkillPath = join(tempDir, "first.md");
    const secondSkillPath = join(tempDir, "second.md");
    await writeFile(
      firstSkillPath,
      dedent`
        ---
        name: first-skill
        description: First skill description.
        ---

        # First Skill

        First skill instructions.
      `,
    );
    await writeFile(
      secondSkillPath,
      dedent`
        ---
        name: second-skill
        description: Second skill description.
        ---

        # Second Skill

        Second skill instructions.
      `,
    );
    const harness = new SkillPromptHarness({
      harnessModel: "anthropic:claude-opus-4-6",
      cwd: process.cwd(),
      skillDiscovery: { includeDefaults: false },
      skills: [
        {
          name: "first-skill",
          description: "First skill description.",
          filePath: firstSkillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
        {
          name: "second-skill",
          description: "Second skill description.",
          filePath: secondSkillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    await harness.getSkills();
    const systemPrompt = harness.systemPromptForTest("Base instructions.");

    expect(systemPrompt).toContain("Available skills:");
    expect(systemPrompt).toContain("<skills>");
    expect(systemPrompt).toContain("name: first-skill");
    expect(systemPrompt).toContain("First skill instructions.");
    expect(systemPrompt).toContain("name: second-skill");
    expect(systemPrompt).toContain("Second skill instructions.");
    expect(systemPrompt).toContain("Base instructions.");
  });

  testIfDocker("discovers project skills from the configured cwd", async () => {
    app = createTestHarness();
    const skillPath = await app.addProjectSkill({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      body: "# Code Review\n\nPrefer direct imports and avoid thin wrappers.",
    });

    const skills = await app.harness.getSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      filePath: skillPath,
      disableModelInvocation: false,
    });
  });

  testIfDocker("discovers global skills from the home directory", async () => {
    app = createTestHarness();
    const skillPath = await app.addGlobalSkill({
      name: "release-notes",
      description: "Draft concise release notes from completed work.",
      body: "# Release Notes\n\nSummarize user-visible changes.",
    });

    const skills = await app.harness.getSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["release-notes"]);
    expect(skills[0]).toMatchObject({
      description: "Draft concise release notes from completed work.",
      filePath: skillPath,
    });
  });

  testIfDocker("parses block scalar skill descriptions", async () => {
    app = createTestHarness();
    await app.addProjectSkill({
      name: "browser-qa",
      description: "|\n  Fast headless browser for QA testing.\n  Use when checking UI flows.",
      body: "# Browser QA\n\nRun quick browser checks.",
    });

    const skills = await app.harness.getSkills();

    expect(skills.map((skill) => skill.description)).toEqual([
      "Fast headless browser for QA testing.\nUse when checking UI flows.\n",
    ]);
  });

  testIfDocker("expands bash commands when injecting selected skill instructions", async () => {
    app = createTestHarness();
    await app.addProjectSkill({
      name: "repo-map",
      description: "Summarize the files in the current repository.",
      body: "# Repo Map\n\nFiles:\n!`printf 'src\\ntest\\n'`",
    });

    await app.harness.getSkills();
    const instructions = app.harness.getSkillInstructions("repo-map");

    expect(instructions).toContain("Files:\nsrc\ntest");
    expect(instructions).not.toContain("!`printf");
  });
});
