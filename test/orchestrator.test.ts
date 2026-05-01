import { afterEach, describe, expect } from "bun:test";
import { testIfDocker } from "./helpers/docker-only.js";
import {
  createTestOrchestrator,
  type TestOrchestratorApp,
} from "./helpers/orchestrator-harness.js";

let app: TestOrchestratorApp | undefined;

afterEach(async () => {
  await app?.cleanup();
  app = undefined;
});

describe("Orchestrator skills", () => {
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
});
