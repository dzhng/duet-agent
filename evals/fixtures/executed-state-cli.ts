import { $ } from "bun";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A missing feature in a tracked synthetic repo, independent of the harness checkout. */
export async function createExecutedStateCliFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "executed-state-cli-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "fixture-cli", version: "1.2.3" }),
    );
    await writeFile(join(cwd, "src/cli.ts"), 'console.log("Fixture CLI");\n');
    await $`git init --quiet`.cwd(cwd).quiet();
    await $`git add .`.cwd(cwd).quiet();
    await $`git -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m baseline`
      .cwd(cwd)
      .quiet();
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  return cwd;
}

/** The worker makes a real edit while its final response misleadingly denies receiving work. */
export async function implementFixtureVersion(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, "src/cli.ts"),
    [
      'import { version } from "../package.json";',
      'console.log(process.argv.includes("--version") ? version : "Fixture CLI");',
      "",
    ].join("\n"),
  );
}
