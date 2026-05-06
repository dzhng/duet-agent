import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../../src/turn-runner/turn-runner.js";

export interface TestSkillInput {
  name: string;
  description: string;
  body?: string;
}

export interface TestTurnRunnerApp {
  runner: TurnRunner;
  /** Project root used as the runner's cwd. Tests can write skills under this path freely. */
  projectRoot: string;
  addProjectDuetSkill(input: TestSkillInput): Promise<string>;
  addProjectAgentSkill(input: TestSkillInput): Promise<string>;
  addGlobalDuetSkill(input: TestSkillInput): Promise<string>;
  addGlobalAgentSkill(input: TestSkillInput): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Build a runner whose project root is an isolated temp directory. Without
 * this, `process.cwd()` would be the repo (or `/work` inside Docker), and
 * any skill the project ships under `.duet/skills` or `.agents/skills`
 * would leak into every skill-discovery test.
 *
 * Global-skill scopes still come from `homedir()`. Skill-discovery tests that
 * touch the global scope are gated on `testIfDocker`, which runs with a clean
 * `HOME=/tmp/home`, so they stay isolated from the developer's real home.
 */
export async function createTestTurnRunner(): Promise<TestTurnRunnerApp> {
  const projectRoot = await mkdtemp(join(tmpdir(), "duet-skill-project-"));
  const runner = new TurnRunner({
    model: "anthropic:claude-opus-4-7",
    cwd: projectRoot,
  });

  const createdGlobalPaths: string[] = [];

  return {
    runner,
    projectRoot,
    addProjectDuetSkill: (input) => writeSkill(join(projectRoot, ".duet", "skills"), input),
    addProjectAgentSkill: (input) => writeSkill(join(projectRoot, ".agents", "skills"), input),
    addGlobalDuetSkill: (input) =>
      writeSkillTracked(join(homedir(), ".duet", "skills"), input, createdGlobalPaths),
    addGlobalAgentSkill: (input) =>
      writeSkillTracked(join(homedir(), ".agents", "skills"), input, createdGlobalPaths),
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true });
      await Promise.all(
        createdGlobalPaths.map((path) => rm(path, { recursive: true, force: true })),
      );
    },
  };
}

async function writeSkillTracked(
  root: string,
  input: TestSkillInput,
  createdPaths: string[],
): Promise<string> {
  const skillDir = join(root, input.name);
  createdPaths.push(skillDir);
  return writeSkill(root, input);
}

async function writeSkill(root: string, input: TestSkillInput): Promise<string> {
  const skillDir = join(root, input.name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${formatFrontmatterValue(input.description)}`,
      "---",
      "",
      input.body ?? `# ${input.name}`,
    ].join("\n"),
  );
  return skillPath;
}

function formatFrontmatterValue(value: string): string {
  return value.replace(/\n/g, "\n  ");
}
