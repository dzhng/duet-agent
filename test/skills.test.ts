import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { testIfDocker } from "./helpers/docker-only.js";
import {
  createTestOrchestrator,
  type TestOrchestratorApp,
} from "./helpers/orchestrator-harness.js";

let app: TestOrchestratorApp | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  await app?.cleanup();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  app = undefined;
  tempDir = undefined;
});

describe("Orchestrator skills", () => {
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
    const orchestrator = new Orchestrator({
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

    const instructions = (
      orchestrator as unknown as { getSkillInstructions(skillId: string): string }
    ).getSkillInstructions("explicit-skill");

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
    const orchestrator = new Orchestrator({
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

    const [skill] = await orchestrator.getSkills();

    expect(skill?.description).toBe("Use when description expansion.");
  });

  testIfDocker("discovers project skills from the configured cwd", async () => {
    app = createTestOrchestrator();
    const skillPath = await app.addProjectSkill({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      body: "# Code Review\n\nPrefer direct imports and avoid thin wrappers.",
    });

    const skills = await app.orchestrator.getSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      filePath: skillPath,
      disableModelInvocation: false,
    });
  });

  testIfDocker("discovers global skills from the home directory", async () => {
    app = createTestOrchestrator();
    const skillPath = await app.addGlobalSkill({
      name: "release-notes",
      description: "Draft concise release notes from completed work.",
      body: "# Release Notes\n\nSummarize user-visible changes.",
    });

    const skills = await app.orchestrator.getSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["release-notes"]);
    expect(skills[0]).toMatchObject({
      description: "Draft concise release notes from completed work.",
      filePath: skillPath,
    });
  });

  testIfDocker("parses block scalar skill descriptions", async () => {
    app = createTestOrchestrator();
    await app.addProjectSkill({
      name: "browser-qa",
      description: "|\n  Fast headless browser for QA testing.\n  Use when checking UI flows.",
      body: "# Browser QA\n\nRun quick browser checks.",
    });

    const skills = await app.orchestrator.getSkills();

    expect(skills.map((skill) => skill.description)).toEqual([
      "Fast headless browser for QA testing.\nUse when checking UI flows.\n",
    ]);
  });

  testIfDocker("expands bash commands when injecting selected skill instructions", async () => {
    app = createTestOrchestrator();
    await app.addProjectSkill({
      name: "repo-map",
      description: "Summarize the files in the current repository.",
      body: "# Repo Map\n\nFiles:\n!`printf 'src\\ntest\\n'`",
    });

    await app.orchestrator.getSkills();
    const instructions = (
      app.orchestrator as unknown as { getSkillInstructions(skillId: string): string }
    ).getSkillInstructions("repo-map");

    expect(instructions).toContain("Files:\nsrc\ntest");
    expect(instructions).not.toContain("!`printf");
  });
});
