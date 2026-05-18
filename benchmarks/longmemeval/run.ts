#!/usr/bin/env bun
/**
 * LongMemEval harness for duet-agent's observational-memory pipeline.
 *
 * Per instance:
 *   1. Per-question isolated MemorySession dataDir under
 *      benchmarks/longmemeval/results/sessions/<question_id>/.
 *   2. Ingest each haystack_session via updateObservationalMemory using
 *      sessionId=haystack_session_ids[i] and now=Date(haystack_dates[i])
 *      so observations carry the real wall-clock that makes
 *      temporal-reasoning / knowledge-update answerable.
 *   3. Read back all stored observations and answer the question with the
 *      duet model gateway. Same shorthand model is used for both the
 *      observer (memory model) and the reader (actor model).
 *   4. Append {question_id, hypothesis} to
 *      benchmarks/longmemeval/results/<run-name>.hyp.jsonl.
 *
 * Usage:
 *   bun benchmarks/longmemeval/run.ts \
 *     --dataset benchmarks/longmemeval/data/longmemeval_oracle.json \
 *     --limit 20 \
 *     --run-name smoke-oracle-20
 *
 * Add --stratify to sample `--limit` items proportionally across
 * `question_type` buckets (deterministic via --seed, default 42) instead
 * of taking the head of the dataset.
 */
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { complete, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { MemorySession } from "../../src/memory/session.js";
import { runMigrations } from "../../src/memory/migrations.js";
import {
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../../src/memory/observational.js";
import { rebuildMemoryContextPack } from "../../src/memory/context-pack.js";
import { MemoryContextCache } from "../../src/memory/store.js";
import { readAllObservations } from "../../src/memory/storage.js";
import { stripObservationGroups } from "../../src/memory/observation-groups.js";
import { resolveModelName } from "../../src/model-resolution/resolver.js";

interface Instance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: "user" | "assistant"; content: string }[][];
  answer_session_ids: string[];
}

interface CliOpts {
  dataset: string;
  /** Cap on items to run. When --stratify is set, this is the size of the stratified sample. */
  limit: number;
  runName: string;
  model: string;
  concurrency: number;
  /** When true, pick `limit` instances proportionally across `question_type` buckets instead of taking the head. */
  stratify: boolean;
  /** Seed for deterministic stratified sampling. */
  seed: number;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  let dataset = "benchmarks/longmemeval/data/longmemeval_oracle.json";
  let limit = 20;
  let runName = "smoke-oracle-20";
  let model = "gpt-5.4-mini";
  let concurrency = 8;
  let stratify = false;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (!v) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--dataset":
        dataset = next();
        break;
      case "--limit":
        limit = Number(next());
        break;
      case "--run-name":
        runName = next();
        break;
      case "--model":
        model = next();
        break;
      case "--concurrency":
        concurrency = Number(next());
        break;
      case "--stratify":
        stratify = true;
        break;
      case "--seed":
        seed = Number(next());
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${concurrency}`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`--seed must be a finite number, got ${seed}`);
  }
  return { dataset, limit, runName, model, concurrency, stratify, seed };
}

/** Deterministic mulberry32 PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample `total` items from `all`, proportionally allocated across
 * `question_type` buckets. Uses largest-remainder rounding so the bucket
 * counts sum to exactly `total`, and a seeded PRNG for the in-bucket pick.
 * Returns items in the dataset's original order so the run log stays readable.
 */
function stratifiedSample(all: Instance[], total: number, seed: number): Instance[] {
  if (total >= all.length) return all.slice();
  const buckets = new Map<string, Instance[]>();
  for (const inst of all) {
    const key = inst.question_type;
    const arr = buckets.get(key);
    if (arr) arr.push(inst);
    else buckets.set(key, [inst]);
  }
  const entries = Array.from(buckets.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const allocations = entries.map(([key, items]) => {
    const exact = (items.length / all.length) * total;
    return { key, items, exact, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let allocated = allocations.reduce((sum, a) => sum + a.base, 0);
  // Distribute remaining slots by largest fractional remainder.
  const byFrac = allocations.slice().sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (allocated < total) {
    const a = byFrac[idx++ % byFrac.length]!;
    if (a.base < a.items.length) {
      a.base++;
      allocated++;
    }
  }

  const rng = mulberry32(seed);
  const chosen: Instance[] = [];
  for (const a of allocations) {
    // Fisher-Yates partial shuffle to pick `base` from `items` deterministically.
    const pool = a.items.slice();
    for (let i = 0; i < a.base; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    chosen.push(...pool.slice(0, a.base));
  }
  // Preserve dataset order.
  const order = new Map(all.map((inst, i) => [inst.question_id, i] as const));
  chosen.sort((x, y) => (order.get(x.question_id) ?? 0) - (order.get(y.question_id) ?? 0));
  return chosen;
}

/** Convert "2023/04/10 (Mon) 23:07" to a Date. */
function parseLmeDate(s: string): Date {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Bad LME date: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)));
}

function sessionToMessages(
  turns: { role: "user" | "assistant"; content: string }[],
  sessionDate: Date,
  actorModel: string,
) {
  let t = sessionDate.getTime();
  return turns.map((turn) => {
    t += 1000;
    if (turn.role === "user") {
      return { role: "user" as const, content: turn.content, timestamp: t };
    }
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: turn.content }],
      api: "anthropic-messages" as const,
      provider: "anthropic" as const,
      model: actorModel,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: t,
    };
  });
}

function asText(content: AssistantMessage["content"]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function ingestInstance(
  inst: Instance,
  dataDir: string,
  memoryModel: string,
): Promise<{ contextText: string }> {
  await mkdir(dataDir, { recursive: true });
  const session = new MemorySession({
    path: dataDir,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    idleCloseMs: 200,
  });
  await session.withDb(async () => {});

  const cache = new MemoryContextCache();
  const settings = resolveObservationalMemorySettings(200_000);
  const cwd = `longmemeval/${inst.question_id}`;

  try {
    for (let i = 0; i < inst.haystack_sessions.length; i++) {
      const turns = inst.haystack_sessions[i]!;
      const sid = inst.haystack_session_ids[i]!;
      const date = parseLmeDate(inst.haystack_dates[i]!);
      const messages = sessionToMessages(turns, date, memoryModel);
      await updateObservationalMemory({
        session,
        memory: cache,
        sessionId: sid,
        effectiveContext: 200_000,
        actorModel: memoryModel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        cwd,
        now: date,
      });
    }

    await rebuildMemoryContextPack({ session, cache, settings });

    const all = (await readAllObservations(session)).observations;
    const text = all
      .map((o) => {
        const date = o.observedDate ?? "????-??-??";
        const time = o.timeOfDay ?? "??:??";
        const stripped = stripObservationGroups(o.content).trim();
        return `[${date} ${time}] (${o.sessionId ?? "?"})\n${stripped}`;
      })
      .join("\n\n");
    return { contextText: text };
  } finally {
    await session.dispose();
  }
}

const READER_SYSTEM = `You are answering a user question using only the memory log below. The memory log is the assistant's prior compressed observations from earlier chat sessions with this user; each entry is dated.

Rules:
- Answer in a single short sentence or phrase. No preamble like "Based on the memory log".
- Use the dates in the memory log to resolve "when", "how long ago", "the latest", "the most recent", etc. relative to the QUESTION DATE.
- If the memory log does not contain enough information to answer, reply exactly: "I don't know."
- For "knowledge-update" style questions where the user's situation has changed over time, prefer the most recent dated observation.
`;

interface ReaderResult {
  hypothesis: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

async function answerQuestion(
  inst: Instance,
  memoryText: string,
  readerModelName: string,
): Promise<ReaderResult> {
  const model = resolveModelName(readerModelName);
  const userMessage = `QUESTION DATE: ${inst.question_date}

MEMORY LOG:
${memoryText || "(empty)"}

QUESTION:
${inst.question}

Answer concisely:`;
  const response = await complete(
    model,
    {
      systemPrompt: READER_SYSTEM,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }] as Message[],
    },
    { maxTokens: 400 },
  );
  return {
    hypothesis: asText(response.content),
    tokensIn: response.usage.input,
    tokensOut: response.usage.output,
    costUsd: response.usage.cost.total,
  };
}

async function main() {
  const opts = parseArgs();
  const repoRoot = resolve(__dirname, "..", "..");
  const datasetPath = resolve(repoRoot, opts.dataset);
  const resultsDir = resolve(repoRoot, "benchmarks/longmemeval/results");
  const sessionsRoot = join(resultsDir, "sessions");
  const hypPath = join(resultsDir, `${opts.runName}.hyp.jsonl`);
  const logPath = join(resultsDir, `${opts.runName}.run.log`);
  const usagePath = join(resultsDir, `${opts.runName}.usage.jsonl`);

  await mkdir(resultsDir, { recursive: true });
  for (const p of [hypPath, logPath, usagePath]) {
    if (existsSync(p)) await rm(p);
  }

  console.log(`# LongMemEval harness`);
  console.log(`dataset:     ${datasetPath}`);
  console.log(`limit:       ${opts.limit}`);
  console.log(`run-name:    ${opts.runName}`);
  console.log(`model:       ${opts.model} (actor + memory)`);
  console.log(`concurrency: ${opts.concurrency}`);
  console.log(`hyp:         ${hypPath}`);

  const raw = await readFile(datasetPath, "utf8");
  const all = JSON.parse(raw) as Instance[];
  const items = opts.stratify
    ? stratifiedSample(all, opts.limit, opts.seed)
    : all.slice(0, opts.limit);
  if (opts.stratify) {
    const counts = new Map<string, number>();
    for (const inst of items)
      counts.set(inst.question_type, (counts.get(inst.question_type) ?? 0) + 1);
    const breakdown = Array.from(counts.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`stratified:  ${items.length} items (seed=${opts.seed}) — ${breakdown}`);
  }

  const start = Date.now();
  let okCount = 0;
  let totalReaderIn = 0;
  let totalReaderOut = 0;
  let totalReaderCost = 0;
  let nextIndex = 0;
  let completed = 0;

  // Serialize JSONL appends across workers so lines never interleave.
  let appendChain: Promise<void> = Promise.resolve();
  const appendLine = (path: string, line: string) => {
    appendChain = appendChain.then(() => appendFile(path, line));
    return appendChain;
  };

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const inst = items[i]!;
      const t0 = Date.now();
      const dataDir = join(sessionsRoot, inst.question_id);
      try {
        const { contextText } = await ingestInstance(inst, dataDir, opts.model);
        const reader = await answerQuestion(inst, contextText, opts.model);
        const wallMs = Date.now() - t0;
        await appendLine(
          hypPath,
          JSON.stringify({ question_id: inst.question_id, hypothesis: reader.hypothesis }) + "\n",
        );
        await appendLine(
          usagePath,
          JSON.stringify({
            question_id: inst.question_id,
            question_type: inst.question_type,
            reader_tokens_in: reader.tokensIn,
            reader_tokens_out: reader.tokensOut,
            reader_cost_usd: reader.costUsd,
            wall_ms: wallMs,
          }) + "\n",
        );
        totalReaderIn += reader.tokensIn;
        totalReaderOut += reader.tokensOut;
        totalReaderCost += reader.costUsd;
        okCount++;
        completed++;
        const dt = (wallMs / 1000).toFixed(1);
        const line = `[w${workerId} ${completed}/${items.length}] ${inst.question_id} (${inst.question_type}) ${dt}s — hyp="${reader.hypothesis.slice(0, 80).replace(/\n/g, " ")}"`;
        console.log(line);
        await appendLine(logPath, line + "\n");
      } catch (e) {
        completed++;
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        const line = `[w${workerId} ${completed}/${items.length}] ${inst.question_id} FAILED: ${msg.slice(0, 600)}`;
        console.error(line);
        await appendLine(logPath, line + "\n");
        await appendLine(
          hypPath,
          JSON.stringify({ question_id: inst.question_id, hypothesis: "I don't know." }) + "\n",
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, items.length) }, (_, w) =>
    worker(w),
  );
  await Promise.all(workers);
  await appendChain;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  await writeFile(
    join(resultsDir, `${opts.runName}.summary.json`),
    JSON.stringify(
      {
        dataset: datasetPath,
        limit: opts.limit,
        runName: opts.runName,
        model: opts.model,
        concurrency: opts.concurrency,
        stratify: opts.stratify,
        seed: opts.stratify ? opts.seed : undefined,
        ok: okCount,
        total: items.length,
        elapsedSec: Number(elapsed),
        readerTokensIn: totalReaderIn,
        readerTokensOut: totalReaderOut,
        readerCostUsd: Number(totalReaderCost.toFixed(6)),
      },
      null,
      2,
    ),
  );
  console.log(`Done: ${okCount}/${items.length} answered in ${elapsed}s.`);
  console.log(
    `Reader tokens: in=${totalReaderIn} out=${totalReaderOut} cost=$${totalReaderCost.toFixed(4)}`,
  );
  console.log(`hyp file: ${hypPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
