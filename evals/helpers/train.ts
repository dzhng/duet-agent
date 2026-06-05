import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { runMigrations } from "../../src/memory/migrations.js";
import { MemorySession } from "../../src/memory/session.js";
import { readAllObservations } from "../../src/memory/storage.js";
import type { Observation } from "../../src/types/memory.js";
import { runTrainCommand } from "../../src/cli/train.js";
import type { TrainManifest } from "../../src/train/types.js";

export interface TrainEvalResult {
  stdout: string;
  stderr: string;
  observation: Observation;
  headline: string;
}

function bufferStream(): { stream: Writable; read: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

export interface RunTrainEvalOptions {
  fixtureDir: string;
  slug: string;
  model: string;
}

/**
 * End-to-end harness for the four real-data train evals. Copies the
 * fixture into tmp (so the agent's writes don't mutate the checked-in
 * fixture), runs `duet train` against an isolated tmp DB, resolves the
 * resulting `train:<slug>` observation row, and reads the archive
 * manifest so the caller can assert on the synthesized headline.
 *
 * Cleanup of the tmp DB, the copied corpus, and the archive directory
 * is handled here in `finally` — including on failure, so a broken eval
 * doesn't leave detritus on disk.
 */
export async function runTrainEval(opts: RunTrainEvalOptions): Promise<TrainEvalResult> {
  const corpusDir = path.join(tmpdir(), `duet-train-corpus-${opts.slug}-${randomUUID()}`);
  mkdirSync(corpusDir, { recursive: true });
  cpSync(opts.fixtureDir, corpusDir, { recursive: true });

  const tmpDb = path.join(tmpdir(), `duet-train-db-${randomUUID()}.db`);

  const stdout = bufferStream();
  const stderr = bufferStream();

  let memoryId: string | undefined;
  try {
    await runTrainCommand([corpusDir, "--slug", opts.slug, "--db", tmpDb, "--model", opts.model], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const handoff = path.join(corpusDir, ".duet-train.json");
    if (existsSync(handoff)) {
      throw new Error(`train: handoff file ${handoff} was not cleaned up`);
    }

    const session = new MemorySession({
      path: tmpDb,
      openOptions: {
        init: async (db) => {
          await runMigrations(db);
        },
      },
      idleCloseMs: 1_000,
    });
    let observation: Observation;
    try {
      const snapshot = await readAllObservations(session);
      const matches = snapshot.observations.filter((row) =>
        row.tags.includes(`train:${opts.slug}`),
      );
      if (matches.length !== 1) {
        throw new Error(`expected exactly 1 row tagged train:${opts.slug}, got ${matches.length}`);
      }
      observation = matches[0]!;
    } finally {
      await session.dispose();
    }
    memoryId = observation.id;

    const archivePath = path.join(homedir(), ".duet", "train", observation.id);
    const manifestRaw = await readFile(path.join(archivePath, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as Pick<TrainManifest, "headline">;
    if (typeof manifest.headline !== "string" || manifest.headline.length === 0) {
      throw new Error(`manifest.json missing headline at ${archivePath}`);
    }

    return {
      stdout: stdout.read(),
      stderr: stderr.read(),
      observation,
      headline: manifest.headline,
    };
  } finally {
    try {
      rmSync(corpusDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(tmpDb, { recursive: true, force: true });
    } catch {}
    if (memoryId) {
      try {
        rmSync(path.join(homedir(), ".duet", "train", memoryId), {
          recursive: true,
          force: true,
        });
      } catch {}
    }
  }
}
