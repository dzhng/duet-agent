import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { Harness } from "../../src/harness/harness.js";

export interface TestSkillInput {
  name: string;
  description: string;
  body?: string;
}

export interface TestHarnessApp {
  harness: Harness;
  addProjectSkill(input: TestSkillInput): Promise<string>;
  addGlobalSkill(input: TestSkillInput): Promise<string>;
  cleanup(): Promise<void>;
}

export function createTestHarness(): TestHarnessApp {
  const root = process.cwd();
  const harness = new Harness({
    harnessModel: "anthropic:claude-opus-4-6",
    cwd: root,
  });

  const createdPaths: string[] = [];

  return {
    harness,
    addProjectSkill: (input) => writeSkill(join(root, ".agents", "skills"), input, createdPaths),
    addGlobalSkill: (input) =>
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
    dedent`
      ---
      name: ${input.name}
      description: ${input.description}
      ---

      ${input.body ?? `# ${input.name}`}
    `,
  );
  return skillPath;
}
