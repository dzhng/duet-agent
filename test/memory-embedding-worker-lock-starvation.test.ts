import { describe, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingBackfillWorker } from "../src/memory/embedding-worker.js";
import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * Regression guard for the cross-process lock-starvation bug: the
 * embedding backfill worker used to wrap its ENTIRE multi-batch drain in
 * one `session.withDb(...)`, so the cross-process `.duet-open.lock` stayed
 * held for the whole drain. Any OTHER duet process opening the same
 * memory.db then blocked in `pollAcquireOpenLock` for its full wait
 * budget and degraded ("memory db busy") — a fresh session's turn-init
 * chains several such waits and hangs for minutes.
 *
 * This models the peer as a truly separate OS process (a spawned bun
 * script), because two `MemorySession`s in the *same* process do not
 * contend (same-pid lock steal in pglite.ts). A slow stub embed makes
 * the drain span many batches. The peer opens with a small lock budget
 * while the worker is mid-drain and must acquire the lock within that
 * budget — which is only possible if the worker releases the lock
 * *between* batches instead of holding it for the whole drain.
 */
describe("EmbeddingBackfillWorker lock starvation", () => {
  const BATCH_SIZE = 50;
  // 30 full batches. On the OLD whole-drain code the lock is held
  // continuously for ~BATCHES*EMBED_MS (~6s), which must stay well above
  // the peer budget so the old code genuinely starves the peer (RED).
  const BATCHES = 30;
  const EMBED_MS = 200; // per-batch stub latency; keep >= ~200 so old-drain still starves
  // Free window the worker leaves between batches. Deliberately > pglite's
  // 1000ms max poll backoff: a peer polling at most every 1000ms is then
  // guaranteed to land a poll inside a free window regardless of how deep
  // its backoff has climbed, so the fixed code reliably lets the peer in.
  const WORKER_YIELD_MS = 1_300;
  // Comfortably below the old whole-drain hold (~6s, minus the peer's
  // ~1s spawn/startup ≈ ~5s of visible continuous hold) so the old code
  // starves the peer, yet several fixed-code cycles (~2.1s each) so the
  // peer reliably wins under the fix.
  const PEER_LOCK_BUDGET_MS = 4_000;

  testIfDocker(
    "releases the cross-process lock between batches so a separate process is not starved for the whole drain",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "duet-lock-starve-"));
      const dataDir = join(tempDir, "memory.db");
      const session = new MemorySession({
        path: dataDir,
        openOptions: {
          init: async (db) => {
            await runMigrations(db);
          },
        },
        idleCloseMs: 500,
      });

      const peerScript = join(tempDir, "peer.mjs");
      await writeFile(peerScript, peerWorkerScript(process.cwd()), "utf8");

      // The worker signals when its first embed call begins; at that
      // instant it is inside `withDb` and holds the cross-process lock.
      let signalFirstEmbed: () => void = () => {};
      const firstEmbedStarted = new Promise<void>((resolve) => {
        signalFirstEmbed = resolve;
      });
      let embedCalls = 0;
      const worker = new EmbeddingBackfillWorker({
        session,
        embed: async (inputs) => {
          embedCalls++;
          if (embedCalls === 1) signalFirstEmbed();
          await sleep(EMBED_MS);
          return { embeddings: inputs.map(() => fillVector(3072, 1)), model: "test-model" };
        },
        // Widen the inter-batch free window past pglite's max poll backoff
        // so the peer reliably wins even if it has climbed deep into its
        // backoff by the time the worker starts yielding.
        interBatchYieldMs: WORKER_YIELD_MS,
      });

      try {
        // Seed a backlog large enough to span many drain batches.
        await session.withDb(async (db) => {
          await db.exec(seedObservations(BATCH_SIZE * BATCHES));
        });

        worker.start();
        // Wait until the drain is genuinely in flight (lock held now).
        await firstEmbedStarted;

        // Now spawn a truly separate process that tries to open the same
        // memory.db with a small lock budget while the worker drains.
        const peer = await spawnPeer(peerScript, dataDir, PEER_LOCK_BUDGET_MS);

        // GREEN: the worker relinquished the lock between batches, so the
        // peer acquired it within its small budget and ran its query.
        // RED (whole-drain withDb): the peer was starved for the entire
        // drain, timed out at the budget, and degraded to "memory db busy".
        expect(peer.error).toBeUndefined();
        expect(peer.degraded).toBe(false);
        expect(peer.acquired).toBe(true);
        expect(peer.rows).toBe(1);
        // Sanity: the peer acquired the lock WHILE the worker still had a
        // large backlog left to embed — proof it got in mid-drain, not
        // because the whole drain had already finished. (The worker was
        // draining and only started; embedCalls has begun climbing.)
        expect(embedCalls).toBeGreaterThanOrEqual(1);
        expect(peer.observationCount).toBe(BATCH_SIZE * BATCHES);
        expect(peer.embeddedCount).toBeLessThan(peer.observationCount);
      } finally {
        await worker.stop();
        await session.dispose();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

interface PeerResult {
  acquired: boolean;
  degraded: boolean;
  rows: number;
  elapsedMs: number;
  observationCount: number;
  embeddedCount: number;
  error?: string;
}

async function spawnPeer(
  scriptPath: string,
  dataDir: string,
  budgetMs: number,
): Promise<PeerResult> {
  const proc = Bun.spawn(["bun", scriptPath, dataDir, String(budgetMs)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  try {
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as PeerResult;
  } catch {
    return {
      acquired: false,
      degraded: false,
      rows: 0,
      elapsedMs: 0,
      observationCount: 0,
      embeddedCount: 0,
      error: `peer produced no JSON; stderr=${stderr}`,
    };
  }
}

function peerWorkerScript(cwd: string): string {
  // One-shot bun script: open the same dataDir through MemorySession with
  // a small lock budget, capture whether the "memory db busy" warning
  // fired, run SELECT 1, and print a single JSON line for the parent.
  return `
import { MemorySession } from "${cwd}/src/memory/session.ts";
import { runMigrations } from "${cwd}/src/memory/migrations.ts";

const dataDir = process.argv[2];
const budgetMs = Number(process.argv[3]);
let warned = false;
const session = new MemorySession({
  path: dataDir,
  openOptions: { init: async (db) => { await runMigrations(db); } },
  lockWaitBudgetMs: budgetMs,
  onWarn: () => { warned = true; },
});
const start = Date.now();
try {
  const result = await session.withDb(async (db) => {
    const ok = (await db.query("SELECT 1 AS ok")).rows.length;
    const obs = await db.query("SELECT COUNT(*)::int AS c FROM observations");
    const emb = await db.query("SELECT COUNT(*)::int AS c FROM observation_embeddings");
    return { rows: ok, observationCount: obs.rows[0].c, embeddedCount: emb.rows[0].c };
  });
  const elapsedMs = Date.now() - start;
  process.stdout.write(
    JSON.stringify({
      acquired: result !== undefined,
      rows: result?.rows ?? 0,
      observationCount: result?.observationCount ?? 0,
      embeddedCount: result?.embeddedCount ?? 0,
      degraded: warned,
      elapsedMs,
    }) + "\\n",
  );
} catch (error) {
  const detail = error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error);
  process.stdout.write(
    JSON.stringify({ acquired: false, rows: 0, observationCount: 0, embeddedCount: 0, degraded: warned, elapsedMs: Date.now() - start, error: detail }) + "\\n",
  );
} finally {
  await session.dispose();
}
`;
}

function seedObservations(count: number): string {
  const rows: string[] = [];
  for (let index = 0; index < count; index++) {
    rows.push(
      `('mem_${index}', ${index + 1}, ${index + 1}, 'observation', '2026-05-04', 'medium', ` +
        `'{"kind":"system"}', 'Memory number ${index}.', '[]')`,
    );
  }
  return `
    INSERT INTO observations (
      id, created_at, last_used_at, kind, observed_date, priority, source_json, content, tags_json
    ) VALUES
    ${rows.join(",\n")};
  `;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fillVector(length: number, value: number): number[] {
  return Array(length).fill(value);
}
