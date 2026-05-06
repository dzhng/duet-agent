import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TurnRunner } from "../../src/turn-runner/turn-runner.js";

export interface TestSkillInput {
  name: string;
  description: string;
  body?: string;
}

export interface TestTurnRunnerApp {
  runner: TurnRunner;
  addProjectDuetSkill(input: TestSkillInput): Promise<string>;
  addProjectAgentSkill(input: TestSkillInput): Promise<string>;
  addGlobalDuetSkill(input: TestSkillInput): Promise<string>;
  addGlobalAgentSkill(input: TestSkillInput): Promise<string>;
  cleanup(): Promise<void>;
}

export function createTestTurnRunner(): TestTurnRunnerApp {
  const root = process.cwd();
  const runner = new TurnRunner({
    model: "anthropic:claude-opus-4-7",
    cwd: root,
  });

  const createdPaths: string[] = [];

  return {
    runner,
    addProjectDuetSkill: (input) => writeSkill(join(root, ".duet", "skills"), input, createdPaths),
    addProjectAgentSkill: (input) =>
      writeSkill(join(root, ".agents", "skills"), input, createdPaths),
    addGlobalDuetSkill: (input) =>
      writeSkill(join(homedir(), ".duet", "skills"), input, createdPaths),
    addGlobalAgentSkill: (input) =>
      writeSkill(join(homedir(), ".agents", "skills"), input, createdPaths),
    cleanup: async () => {
      await Promise.all(createdPaths.map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}

async function writeSkill(
  root: string,
  input: TestSkillInput,
  createdPaths: string[],
): Promise<string> {
  const skillDir = join(root, input.name);
  createdPaths.push(skillDir);
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
