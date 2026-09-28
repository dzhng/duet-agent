import { expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import baseline from "./fixtures/model-refresh/standalone-baseline.json" with { type: "json" };
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker(
  "clear after resume uses fresh CLI defaults including the project tier and explicit flags",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-clear-"));
    try {
      for (const selection of ["frontier", "project-default", "sol", "legacy"]) {
        const cwd = join(dir, selection);
        const home = join(cwd, "home");
        const sessionPath = join(home, ".duet", "sessions", "saved");
        await mkdir(sessionPath, { recursive: true });
        await writeFile(
          join(sessionPath, "state.json"),
          JSON.stringify(baseline.receipts.find((item) => item.input === "opus")!.envelope),
        );
        if (selection === "legacy") {
          const otherPath = join(home, ".duet", "sessions", "other");
          await mkdir(otherPath, { recursive: true });
          await writeFile(
            join(otherPath, "state.json"),
            JSON.stringify(baseline.receipts.find((item) => item.input === "sol")!.envelope),
          );
        }
        if (selection === "project-default") {
          const table = structuredClone(BUILT_IN_ROUTING_TABLE);
          table.defaultTier = selection;
          table.tiers[selection] = structuredClone(table.tiers.frontier!);
          await mkdir(join(cwd, ".duet"));
          await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
        }
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "fixtures", "cli-resume-clear.ts"),
            cwd,
            ...(selection === "sol"
              ? ["--model", "sol", "--memory-model", "luna"]
              : selection === "legacy"
                ? ["--model", "opus-5", "--memory-model", "gpt-5.6-luna"]
                : []),
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              DUET_API_KEY: "controlled-clear-key",
              DUET_TEST_CLEAR_RESUME_OTHER: selection === "legacy" ? "1" : "0",
            },
            timeout: 10_000,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, stderr).toBe(0);
        const [resumed, fresh, picked] = JSON.parse(stdout);
        const expectedModel = selection === "legacy" ? "opus" : selection;
        expect(resumed.model).toBe(selection === "sol" ? "sol" : "opus");
        expect(fresh).toMatchObject({
          model: expectedModel,
          displayModel: expectedModel,
          memoryModel: "luna",
        });
        if (selection === "sol" || selection === "legacy") expect(fresh.routing).toBeUndefined();
        if (selection === "legacy")
          expect(picked).toMatchObject({
            model: "opus",
            displayModel: "opus",
            memoryModel: "luna",
          });
        if (selection !== "sol" && selection !== "legacy")
          expect(fresh.routing).toMatchObject({
            tier: selection,
            advisorEnabled: true,
            pinned: false,
          });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

testIfDocker(
  "inline model override matching the fresh default wins on resume",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-inline-resume-"));
    const home = join(cwd, "home");
    const sessionPath = join(home, ".duet", "sessions", "saved");
    try {
      await mkdir(sessionPath, { recursive: true });
      await writeFile(
        join(sessionPath, "state.json"),
        JSON.stringify(baseline.receipts.find((item) => item.input === "sol")!.envelope),
      );
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "..", "src", "cli-entry.ts"),
          "--resume",
          "saved",
          "--incognito",
          "--no-auto-upgrade",
          "--workdir",
          cwd,
          "/model frontier",
        ],
        {
          env: { ...process.env, HOME: home, DUET_API_KEY: "controlled-inline-key" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stderr).toContain("Model: frontier");
      expect(
        JSON.parse(await readFile(join(sessionPath, "state.json"), "utf8")).state.options.model,
      ).toBe("frontier");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15000,
);
