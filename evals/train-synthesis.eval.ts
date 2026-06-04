import { describe, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { runTrainCommand } from "../src/cli/train.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const fixtureDir = path.join(import.meta.dir, "fixtures", "train-corpus");

// Sink the writable streams `runTrainCommand` expects so the eval doesn't
// pollute test output.
function nullStream(): NodeJS.WritableStream {
  return {
    write: () => true,
    end: () => {},
    // The runner only calls `write`. Pad enough of the surface for the type.
  } as unknown as NodeJS.WritableStream;
}

describe("train synthesis", () => {
  testIfDocker(
    "agent-driven train writes AGENTS.md + persists observation",
    async () => {
      const tmp = await mkdtemp(path.join(tmpdir(), "duet-train-eval-"));
      const dbPath = path.join(tmp, "memory.db");
      const agentsMdPath = path.join(fixtureDir, "AGENTS.md");
      const handoffPath = path.join(fixtureDir, ".duet-train.json");

      try {
        await runTrainCommand(
          [fixtureDir, "--db", dbPath, "--model", model, "--slug", "train-corpus"],
          { stdout: nullStream(), stderr: nullStream() },
        );

        // (1) AGENTS.md exists at the corpus root, mentions Fernweb, has body.
        const agentsMd = await readFile(agentsMdPath, "utf8");
        expect(agentsMd.length).toBeGreaterThan(100);
        expect(agentsMd.toLowerCase()).toContain("fernweb");

        // (2) The handoff file is cleaned up after the run.
        const handoffStat = await stat(handoffPath).catch(() => undefined);
        expect(handoffStat).toBeUndefined();

        // (3) Exactly one row tagged `train:train-corpus` landed in the DB.
        const { MemorySession } = await import("../src/memory/session.js");
        const { runMigrations } = await import("../src/memory/migrations.js");
        const session = new MemorySession({
          path: dbPath,
          openOptions: {
            init: async (db) => {
              await runMigrations(db);
            },
          },
          idleCloseMs: 5_000,
        });
        try {
          const rows = await session.withDb(async (db) =>
            db.query<{ id: string; content: string; tags_json: string }>(
              "SELECT id, content, tags_json FROM observations",
            ),
          );
          const matching = (rows?.rows ?? []).filter((r) => {
            try {
              const tags = JSON.parse(r.tags_json);
              return Array.isArray(tags) && tags.includes("train:train-corpus");
            } catch {
              return false;
            }
          });
          expect(matching.length).toBe(1);
          expect(matching[0]!.content.length).toBeGreaterThan(50);
        } finally {
          await session.dispose();
        }
      } finally {
        // Don't leave a stale AGENTS.md or handoff in the fixture even when the
        // eval is run locally outside the docker container.
        await rm(agentsMdPath, { force: true });
        await rm(handoffPath, { force: true });
        await rm(tmp, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
