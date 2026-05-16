import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn } from "bun:test";
import dedent from "dedent";
import { runSkillsCommand } from "../src/cli/skills.js";
import { discoverInstalledSkills, resolveSkillScope } from "../src/turn-runner/skills.js";
import { testIfDocker } from "./helpers/docker-only.js";

type SkillsCliOutput = {
  skills: Array<{ name: string; description?: string; path: string; scope: string }>;
  collisions: Array<{ name: string; winnerPath: string; loserPath: string }>;
};

function captureSkillsCli(args: string[]): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    return true;
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    return true;
  });
  try {
    runSkillsCommand(args);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout, stderr };
}

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
    const output = skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      scope: resolveSkillScope(skill, root),
    }));

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

  testIfDocker("prints { skills, collisions } JSON on stdout with nothing on stderr", async () => {
    const root = (projectRoot = await mkdtemp(join(tmpdir(), "duet-cli-skills-")));
    const skillDir = await writeSkill(join(root, ".duet", "skills"), "deploy", "Deploy the app.");

    const { stdout, stderr } = captureSkillsCli(["--workdir", root]);
    const parsed = JSON.parse(stdout) as SkillsCliOutput;

    expect(stderr).toBe("");
    expect(parsed.collisions).toEqual([]);
    expect(parsed.skills).toEqual([
      {
        name: "deploy",
        description: "Deploy the app.",
        path: skillDir,
        scope: "project",
      },
    ]);
  });

  testIfDocker("surfaces name collisions in the JSON collisions key, not on stderr", async () => {
    const root = (projectRoot = await mkdtemp(join(tmpdir(), "duet-cli-skills-")));
    // Two skills with the same name in different scopes — .duet wins over
    // .agents because .duet is scanned first.
    const winner = await writeSkill(
      join(root, ".duet", "skills"),
      "release",
      "Cut a release (canonical).",
    );
    const loser = await writeSkill(
      join(root, ".agents", "skills"),
      "release",
      "Cut a release (shadowed).",
    );

    const { stdout, stderr } = captureSkillsCli(["--workdir", root]);
    const parsed = JSON.parse(stdout) as SkillsCliOutput;

    expect(stderr).toBe("");
    expect(parsed.skills.map((skill) => skill.path)).toEqual([winner]);
    expect(parsed.collisions).toEqual([
      {
        name: "release",
        winnerPath: join(winner, "SKILL.md"),
        loserPath: join(loser, "SKILL.md"),
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
    const summary = skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      scope: resolveSkillScope(skill, root),
    }));

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
