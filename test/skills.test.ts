import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Skill } from "@mariozechner/pi-coding-agent";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "./helpers/docker-only.js";
import { createTurnRunner } from "./helpers/turn-runner-protocol.js";
import { createTestTurnRunner, type TestTurnRunnerApp } from "./helpers/skills-turn-runner.js";

let app: TestTurnRunnerApp | undefined;
let tempDir: string | undefined;

class SkillPromptTurnRunner extends TurnRunner {
  systemPromptForTest(systemPrompt?: string): string {
    return this.createBaseSystemPromptWithAppendedLayers({ append: [systemPrompt] });
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

describe("TurnRunner skills", () => {
  testIfDocker("expands bash commands for explicitly provided skills", async () => {
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
    const runner = new TurnRunner({
      model: "anthropic:claude-opus-4-7",
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

    const instructions = runner.getSkillInstructions("explicit-skill");

    expect(instructions).toContain("expanded value");
    expect(instructions).not.toContain("!`printf");
  });

  testIfDocker("expands bash commands in skill descriptions", async () => {
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
    const runner = new TurnRunner({
      model: "anthropic:claude-opus-4-7",
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

    const [skill] = await runner.getSkills();

    expect(skill?.description).toBe("Use when description expansion.");
  });

  testIfDocker(
    "injects skill metadata only (not full instructions) into the system prompt",
    async () => {
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
      const runner = new SkillPromptTurnRunner({
        model: "anthropic:claude-opus-4-7",
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

      await runner.getSkills();
      const systemPrompt = runner.systemPromptForTest("Base instructions.");

      expect(systemPrompt).toContain("Available skills");
      expect(systemPrompt).toContain("<skills>");
      expect(systemPrompt).toContain("name: first-skill");
      expect(systemPrompt).toContain("First skill description.");
      expect(systemPrompt).toContain("name: second-skill");
      expect(systemPrompt).toContain("Second skill description.");
      expect(systemPrompt).toContain("Base instructions.");
      // Full SKILL.md bodies must NOT be inlined — they're loaded on demand via the read_skill tool.
      expect(systemPrompt).not.toContain("First skill instructions.");
      expect(systemPrompt).not.toContain("Second skill instructions.");
      expect(systemPrompt).toContain("read_skill");
    },
  );

  testIfDocker(
    "injects full skill instructions for slash command prompts at runner level",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
      const skillPath = join(tempDir, "SKILL.md");
      await writeFile(
        skillPath,
        dedent`
        ---
        name: review
        description: Review changed code.
        ---

        # Review Skill

        Use the full review checklist.
      `,
      );
      const { runner } = createTurnRunner({
        mode: "agent",
        skills: [
          {
            name: "review",
            description: "Review changed code.",
            filePath: skillPath,
            baseDir: tempDir,
            sourceInfo: {} as Skill["sourceInfo"],
            disableModelInvocation: false,
          },
        ],
      });

      await runner.turn({ type: "start", prompt: "/review audit this diff" });

      expect(runner.workerInputs[0]?.prompt).toBe(dedent`
      /review audit this diff

      <skill name="review">
      Use the following skill instructions for this request.
      <instructions>
      ---
      name: review
      description: Review changed code.
      ---

      # Review Skill

      Use the full review checklist.
      </instructions>
      </skill>
    `);
    },
  );

  testIfDocker("injects multiple slash command skills at runner level", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const reviewPath = join(tempDir, "review.md");
    const repoMapPath = join(tempDir, "repo-map.md");
    await writeFile(
      reviewPath,
      dedent`
        ---
        name: review
        description: Review changed code.
        ---

        # Review Skill

        Use the review checklist.
      `,
    );
    await writeFile(
      repoMapPath,
      dedent`
        ---
        name: repo-map
        description: Summarize the repository.
        ---

        # Repo Map Skill

        Build a concise repository map.
      `,
    );
    const { runner } = createTurnRunner({
      mode: "agent",
      skills: [
        {
          name: "review",
          description: "Review changed code.",
          filePath: reviewPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
        {
          name: "repo-map",
          description: "Summarize the repository.",
          filePath: repoMapPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    await runner.turn({ type: "start", prompt: "/review /repo-map audit this diff" });

    expect(runner.workerInputs[0]?.prompt).toBe(dedent`
      /review /repo-map audit this diff

      <skill name="review">
      Use the following skill instructions for this request.
      <instructions>
      ---
      name: review
      description: Review changed code.
      ---

      # Review Skill

      Use the review checklist.
      </instructions>
      </skill>

      <skill name="repo-map">
      Use the following skill instructions for this request.
      <instructions>
      ---
      name: repo-map
      description: Summarize the repository.
      ---

      # Repo Map Skill

      Build a concise repository map.
      </instructions>
      </skill>
    `);
  });

  testIfDocker("injects slash command skills from anywhere in the prompt", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const skillPath = join(tempDir, "SKILL.md");
    await writeFile(
      skillPath,
      dedent`
        ---
        name: review
        description: Review changed code.
        ---

        # Review Skill
      `,
    );
    const { runner } = createTurnRunner({
      mode: "agent",
      skills: [
        {
          name: "review",
          description: "Review changed code.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    await runner.turn({ type: "start", prompt: "audit this diff /review carefully" });

    expect(runner.workerInputs[0]?.prompt).toBe(dedent`
      audit this diff /review carefully

      <skill name="review">
      Use the following skill instructions for this request.
      <instructions>
      ---
      name: review
      description: Review changed code.
      ---

      # Review Skill
      </instructions>
      </skill>
    `);
  });

  testIfDocker("preserves unknown slash commands while injecting known slash skills", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "duet-skill-"));
    const skillPath = join(tempDir, "SKILL.md");
    await writeFile(
      skillPath,
      dedent`
        ---
        name: review
        description: Review changed code.
        ---

        # Review Skill
      `,
    );
    const { runner } = createTurnRunner({
      mode: "agent",
      skills: [
        {
          name: "review",
          description: "Review changed code.",
          filePath: skillPath,
          baseDir: tempDir,
          sourceInfo: {} as Skill["sourceInfo"],
          disableModelInvocation: false,
        },
      ],
    });

    await runner.turn({ type: "start", prompt: "/missing /review audit this diff" });

    expect(runner.workerInputs[0]?.prompt).toBe(dedent`
      /missing /review audit this diff

      <skill name="review">
      Use the following skill instructions for this request.
      <instructions>
      ---
      name: review
      description: Review changed code.
      ---

      # Review Skill
      </instructions>
      </skill>
    `);
  });

  test("leaves unknown slash command prompts unchanged at runner level", async () => {
    const { runner } = createTurnRunner({ mode: "agent" });

    await runner.turn({ type: "start", prompt: "/missing do work" });

    expect(runner.workerInputs[0]?.prompt).toBe("/missing do work");
  });

  testIfDocker("discovers project skills from .duet in the configured cwd", async () => {
    app = createTestTurnRunner();
    const skillPath = await app.addProjectDuetSkill({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      body: "# Code Review\n\nPrefer direct imports and avoid thin wrappers.",
    });

    const skills = await app.runner.getSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "code-review",
      description: "Review changed code for correctness and simplicity.",
      filePath: skillPath,
      disableModelInvocation: false,
    });
  });

  testIfDocker("discovers standard project skills from .agents in the configured cwd", async () => {
    app = createTestTurnRunner();
    const skillPath = await app.addProjectAgentSkill({
      name: "standard-review",
      description: "Review changed code from the standard skill directory.",
      body: "# Standard Review\n\nUse the standard project skill.",
    });

    const skills = await app.runner.getSkills();

    expect(skills.map((skill) => skill.name)).toEqual(["standard-review"]);
    expect(skills[0]).toMatchObject({
      description: "Review changed code from the standard skill directory.",
      filePath: skillPath,
    });
  });

  testIfDocker("discovers project skills from both .duet and .agents", async () => {
    app = createTestTurnRunner();
    const duetSkillPath = await app.addProjectDuetSkill({
      name: "duet-docs",
      description: "Document Duet-specific workflows.",
      body: "# Duet Docs\n\nUse the Duet project skill.",
    });
    const agentSkillPath = await app.addProjectAgentSkill({
      name: "agent-review",
      description: "Review code using standard agent guidance.",
      body: "# Agent Review\n\nUse the standard project skill.",
    });

    const skills = await app.runner.getSkills();

    expect(skills.map((skill) => skill.name)).toEqual(["duet-docs", "agent-review"]);
    expect(skills).toContainEqual(
      expect.objectContaining({
        name: "duet-docs",
        description: "Document Duet-specific workflows.",
        filePath: duetSkillPath,
      }),
    );
    expect(skills).toContainEqual(
      expect.objectContaining({
        name: "agent-review",
        description: "Review code using standard agent guidance.",
        filePath: agentSkillPath,
      }),
    );
  });

  testIfDocker("discovers global skills from .duet in the home directory", async () => {
    app = createTestTurnRunner();
    const skillPath = await app.addGlobalDuetSkill({
      name: "release-notes",
      description: "Draft concise release notes from completed work.",
      body: "# Release Notes\n\nSummarize user-visible changes.",
    });

    const skills = await app.runner.getSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["release-notes"]);
    expect(skills[0]).toMatchObject({
      description: "Draft concise release notes from completed work.",
      filePath: skillPath,
    });
  });

  testIfDocker("discovers standard global skills from .agents in the home directory", async () => {
    app = createTestTurnRunner();
    const skillPath = await app.addGlobalAgentSkill({
      name: "standard-release-notes",
      description: "Draft release notes from the standard skill directory.",
      body: "# Standard Release Notes\n\nSummarize user-visible changes.",
    });

    const skills = await app.runner.getSkills();

    expect(skills.map((skill) => skill.name)).toEqual(["standard-release-notes"]);
    expect(skills[0]).toMatchObject({
      description: "Draft release notes from the standard skill directory.",
      filePath: skillPath,
    });
  });

  testIfDocker("parses block scalar skill descriptions", async () => {
    app = createTestTurnRunner();
    await app.addProjectDuetSkill({
      name: "browser-qa",
      description: "|\n  Fast headless browser for QA testing.\n  Use when checking UI flows.",
      body: "# Browser QA\n\nSession quick browser checks.",
    });

    const skills = await app.runner.getSkills();

    expect(skills.map((skill) => skill.description)).toEqual([
      "Fast headless browser for QA testing.\nUse when checking UI flows.\n",
    ]);
  });

  testIfDocker("expands bash commands when injecting selected skill instructions", async () => {
    app = createTestTurnRunner();
    await app.addProjectDuetSkill({
      name: "repo-map",
      description: "Summarize the files in the current repository.",
      body: "# Repo Map\n\nFiles:\n!`printf 'src\\ntest\\n'`",
    });

    await app.runner.getSkills();
    const instructions = app.runner.getSkillInstructions("repo-map");

    expect(instructions).toContain("Files:\nsrc\ntest");
    expect(instructions).not.toContain("!`printf");
  });
});
