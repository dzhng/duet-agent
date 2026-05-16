import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import dedent from "dedent";
import { discoverInstalledSkills, resolveSkillScope } from "../src/turn-runner/skills.js";
import { testIfDocker } from "./helpers/docker-only.js";

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "Skill body",
): Promise<string> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  await writeFile(
    filePath,
    dedent`
      ---
      name: ${name}
      description: ${description}
      ---

      ${body}
    `,
  );
  return skillDir;
}

describe("CLI skills command", () => {
  // The `duet skills` command serializes each discovered skill with these four
  // fields. Locking the shape here keeps the JSON output stable for any tool
  // that consumes it.
  testIfDocker("returns name, description, path, and scope for project skills", async () => {
    const root = (projectRoot = await mkdtemp(join(tmpdir(), "duet-cli-skills-")));
    const skillDir = await writeSkill(
      join(root, ".duet", "skills"),
      "release",
      "Bump the version and push tags.",
    );

    const { skills, collisions } = discoverInstalledSkills(root);
    const output = skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.baseDir,
        scope: resolveSkillScope(skill, root),
      }))
      // Built-in skills are returned alongside user/project ones; this test
      // is scoped to the project-discovery shape, so drop the built-ins.
      .filter((s) => s.scope !== "builtin");

    expect(collisions).toEqual([]);
    expect(output).toEqual([
      {
        name: "release",
        description: "Bump the version and push tags.",
        path: skillDir,
        scope: "project",
      },
    ]);
  });

  testIfDocker("reports the project scope for .agents skills too", async () => {
    const root = (projectRoot = await mkdtemp(join(tmpdir(), "duet-cli-skills-")));
    const skillDir = await writeSkill(
      join(root, ".agents", "skills"),
      "review",
      "Review code before committing.",
    );

    const { skills } = discoverInstalledSkills(root);
    const summary = skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.baseDir,
        scope: resolveSkillScope(skill, root),
      }))
      .filter((s) => s.scope !== "builtin");

    expect(summary).toEqual([
      {
        name: "review",
        description: "Review code before committing.",
        path: skillDir,
        scope: "project",
      },
    ]);
  });
});
