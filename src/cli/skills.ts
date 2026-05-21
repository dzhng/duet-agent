import { discoverInstalledSkills, resolveSkillScope } from "../turn-runner/skills.js";
import { printSkillsHelp } from "./help.js";
import { expandHomeDir, fail } from "./shared.js";

/**
 * Run `duet skills` — print installed skills as JSON.
 *
 * Emits a JSON object with two keys:
 *   - `skills`: array of `{ name, description, path, scope }` — scope is
 *     `"user" | "project" | "temporary" | "builtin"`.
 *   - `collisions`: array of `{ name, winnerPath, loserPath }` for any
 *     name conflicts that were resolved while discovering skills.
 *
 * Nothing is written to stderr on the happy path; stderr is reserved for
 * cases where the JSON itself cannot be produced.
 */
export function runSkillsCommand(args: string[]): void {
  let workDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workdir":
      case "-w":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workDir = expandHomeDir(args[++i]!);
        break;
      case "--help":
      case "-h":
        printSkillsHelp();
        return;
      default:
        fail(`Unknown skills option: ${args[i]}`);
    }
  }

  const { skills, collisions } = discoverInstalledSkills(workDir);
  const output = {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      scope: resolveSkillScope(skill, workDir),
    })),
    collisions: collisions.map((collision) => ({
      name: collision.name,
      winnerPath: collision.winnerPath,
      loserPath: collision.loserPath,
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
