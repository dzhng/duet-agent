#!/usr/bin/env bun
/**
 * Extraction-prompt tuning measurement. Runs each model over every corpus
 * with the CURRENT `TRAIN_SYSTEM_PROMPT` (src/cli/train.ts), grades the
 * synthesized observation against the committed gold rubrics, and prints
 * per-model coverage PLUS the specific 'must' facts each model missed —
 * the signal the tuning loop edits the prompt against.
 *
 * Unlike sweep.ts (aggregate table only) this surfaces the misses and
 * writes a JSON snapshot to evals/scripts/.tune-last.json for the relay.
 *
 * Needs DUET_API_KEY (or ANTHROPIC_API_KEY). Not Docker — drives the train
 * harness in-process. Rubrics must already exist.
 *
 *   bun run evals/scripts/tune-measure.ts                     # sonnet-4.6 + opus-4.8
 *   bun run evals/scripts/tune-measure.ts sonnet-4.6          # sonnet only
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CORPORA, fixtureDirFor, rubricPathFor } from "../helpers/corpora.js";
import { gradeAgainstRubric, type GradeResult, type Rubric } from "../helpers/rubric.js";
import { runTrainEval } from "../helpers/train.js";

const judgeModel = process.env.JUDGE_MODEL ?? "opus-4.7";
const argv = process.argv.slice(2);
const candidates = argv.length ? argv : ["sonnet-4.6", "opus-4.8"];

interface CellResult {
  coverage: number | null;
  mustCovered: number;
  mustTotal: number;
  missed: Array<{ id: string; fact: string; reason: string }>;
  error?: string;
}

const table: Record<string, Record<string, CellResult>> = {};

for (const model of candidates) {
  table[model] = {};
  for (const c of CORPORA) {
    const rubricPath = rubricPathFor(c);
    if (!existsSync(rubricPath)) {
      console.error(`! skip ${c.slug}: missing rubric (run generate-rubrics.ts ${c.slug})`);
      table[model]![c.slug] = { coverage: null, mustCovered: 0, mustTotal: 0, missed: [] };
      continue;
    }
    const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as Rubric;
    process.stderr.write(`[${model}] ${c.slug}... `);
    try {
      const result = await runTrainEval({ fixtureDir: fixtureDirFor(c), slug: c.slug, model });
      const grade: GradeResult = await gradeAgainstRubric({
        rubric,
        observation: result.observation.content,
        judgeModel,
      });
      const missed = grade.verdicts
        .filter((v) => v.importance === "must" && !v.covered)
        .map((v) => ({ id: v.id, fact: v.fact, reason: v.reason }));
      table[model]![c.slug] = {
        coverage: grade.coverage,
        mustCovered: grade.mustCovered,
        mustTotal: grade.mustTotal,
        missed,
      };
      console.error(
        `${grade.mustCovered}/${grade.mustTotal} (${(grade.coverage * 100).toFixed(0)}%)`,
      );
    } catch (err) {
      table[model]![c.slug] = {
        coverage: null,
        mustCovered: 0,
        mustTotal: 0,
        missed: [],
        error: (err as Error).message,
      };
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }
}

const avg = (model: string): number | null => {
  const vals = CORPORA.map((c) => table[model]![c.slug].coverage).filter(
    (v): v is number => v !== null,
  );
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

// --- Coverage table ---
const pct = (v: number | null) => (v === null ? "  —  " : `${(v * 100).toFixed(0)}%`);
const slugCol = Math.max(8, ...CORPORA.map((c) => c.slug.length));
console.log(`\nMust-fact coverage (judge: ${judgeModel})\n`);
console.log(["corpus".padEnd(slugCol), ...candidates.map((m) => m.padStart(13))].join(" | "));
console.log(["-".repeat(slugCol), ...candidates.map(() => "-".repeat(13))].join(" | "));
for (const c of CORPORA) {
  console.log(
    [
      c.slug.padEnd(slugCol),
      ...candidates.map((m) => pct(table[m]![c.slug].coverage).padStart(13)),
    ].join(" | "),
  );
}
console.log(["-".repeat(slugCol), ...candidates.map(() => "-".repeat(13))].join(" | "));
console.log(
  ["average".padEnd(slugCol), ...candidates.map((m) => pct(avg(m)).padStart(13))].join(" | "),
);

// --- Per-model missed must-facts (the tuning signal) ---
for (const model of candidates) {
  console.log(`\n### ${model} — missed 'must' facts\n`);
  let any = false;
  for (const c of CORPORA) {
    const cell = table[model]![c.slug];
    if (cell.error) {
      console.log(`- ${c.slug}: ERROR — ${cell.error}`);
      any = true;
      continue;
    }
    for (const m of cell.missed) {
      any = true;
      console.log(`- ${c.slug} [${m.id}] ${m.fact}\n    judge: ${m.reason}`);
    }
  }
  if (!any) console.log("(none — full coverage)");
}

// --- Snapshot for the relay ---
const snapshotPath = path.join(import.meta.dir, ".tune-last.json");
writeFileSync(
  snapshotPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      judgeModel,
      averages: Object.fromEntries(candidates.map((m) => [m, avg(m)])),
      table,
    },
    null,
    2,
  ),
);
console.log(`\nsnapshot: ${snapshotPath}`);

// Gap summary line the orchestrator can read at a glance.
if (candidates.includes("sonnet-4.6") && candidates.includes("opus-4.8")) {
  const s = avg("sonnet-4.6");
  const o = avg("opus-4.8");
  if (s !== null && o !== null) {
    console.log(
      `\nGAP sonnet-4.6 vs opus-4.8: ${(s * 100).toFixed(0)}% vs ${(o * 100).toFixed(0)}% (delta ${((s - o) * 100).toFixed(0)} pts)`,
    );
  }
}
