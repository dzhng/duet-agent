#!/usr/bin/env bun
/**
 * Model-comparison sweep. Runs each candidate model over every corpus,
 * grades the synthesized observation against the committed gold-standard
 * rubrics, and prints a coverage table.
 *
 * Needs model credentials (DUET_API_KEY or ANTHROPIC_API_KEY) but NOT Docker
 * — it drives the train harness in-process. Rubrics must already exist
 * (run generate-rubrics.ts first).
 *
 *   bun run evals/scripts/sweep.ts                          # default 3-model sweep
 *   bun run evals/scripts/sweep.ts opus-4.8 sonnet-4.6      # custom model list
 */
import { existsSync, readFileSync } from "node:fs";

import { CORPORA, fixtureDirFor, rubricPathFor } from "../helpers/corpora.js";
import { gradeAgainstRubric, type Rubric } from "../helpers/rubric.js";
import { runTrainEval } from "../helpers/train.js";

const judgeModel = process.env.JUDGE_MODEL ?? "opus-4.7";
const models = process.argv.slice(2);
const candidates = models.length ? models : ["opus-4.8", "sonnet-4.6", "gpt-5.4-mini"];

// model -> slug -> coverage (0..1), or null on failure
const table: Record<string, Record<string, number | null>> = {};

for (const model of candidates) {
  table[model] = {};
  for (const c of CORPORA) {
    const rubricPath = rubricPathFor(c);
    if (!existsSync(rubricPath)) {
      console.error(`! skip ${c.slug}: missing rubric (run generate-rubrics.ts ${c.slug})`);
      table[model]![c.slug] = null;
      continue;
    }
    const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as Rubric;
    process.stderr.write(`[${model}] ${c.slug}... `);
    try {
      const result = await runTrainEval({ fixtureDir: fixtureDirFor(c), slug: c.slug, model });
      const grade = await gradeAgainstRubric({
        rubric,
        observation: result.observation.content,
        judgeModel,
      });
      table[model]![c.slug] = grade.coverage;
      console.error(
        `${grade.mustCovered}/${grade.mustTotal} (${(grade.coverage * 100).toFixed(0)}%)`,
      );
    } catch (err) {
      table[model]![c.slug] = null;
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }
}

// --- Print markdown comparison table (must-fact coverage %) ---
const pct = (v: number | null) => (v === null ? "  —  " : `${(v * 100).toFixed(0)}%`.padStart(5));
const slugCol = Math.max(8, ...CORPORA.map((c) => c.slug.length));
const header = ["corpus".padEnd(slugCol), ...candidates.map((m) => m.padStart(13))].join(" | ");
const sep = ["-".repeat(slugCol), ...candidates.map(() => "-".repeat(13))].join(" | ");

console.log(`\nMust-fact coverage (judge: ${judgeModel})\n`);
console.log(header);
console.log(sep);
for (const c of CORPORA) {
  const row = [
    c.slug.padEnd(slugCol),
    ...candidates.map((m) => pct(table[m]![c.slug]).padStart(13)),
  ];
  console.log(row.join(" | "));
}
const avg = (m: string) => {
  const vals = CORPORA.map((c) => table[m]![c.slug]).filter((v): v is number => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
console.log(sep);
console.log(
  ["average".padEnd(slugCol), ...candidates.map((m) => pct(avg(m)).padStart(13))].join(" | "),
);
