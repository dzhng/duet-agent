import { expect } from "bun:test";
import { $ } from "bun";
import { rm } from "node:fs/promises";
import {
  createExecutedStateCliFixture,
  implementFixtureVersion,
} from "../evals/fixtures/executed-state-cli.js";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker(
  "executed-state fixture starts missing the feature and the worker leaves a working diff",
  async () => {
    const cwd = await createExecutedStateCliFixture();
    try {
      expect((await $`bun src/cli.ts --version`.cwd(cwd).text()).trim()).toBe("Fixture CLI");
      await implementFixtureVersion(cwd);
      expect((await $`bun src/cli.ts --version`.cwd(cwd).text()).trim()).toBe("1.2.3");
      expect(await $`git diff -- src/cli.ts`.cwd(cwd).text()).toContain(
        'process.argv.includes("--version")',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
