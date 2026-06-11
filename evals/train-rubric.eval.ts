import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { testIfDocker } from "../test/helpers/docker-only.js";
import { CORPORA, fixtureDirFor, rubricPathFor } from "./helpers/corpora.js";
import { gradeAgainstRubric, type Rubric } from "./helpers/rubric.js";
import { runTrainEval } from "./helpers/train.js";

/**
 * Comparative train eval. Step 2 of the model-comparison workflow: run a
 * candidate model (EVAL_MODEL) over each corpus, then grade the synthesized
 * observation against the gold-standard rubric established by Opus 4.8
 * (evals/rubrics/<slug>.json). Coverage = fraction of 'must' facts conveyed.
 *
 *   EVAL_MODEL=sonnet-4.6 npm run eval        # via the docker harness
 *
 * Grading always uses a fixed strong judge (JUDGE_MODEL, default opus-4.7)
 * so scores are comparable across candidate models.
 */
const model = process.env.EVAL_MODEL ?? "opus-4.8";
const judgeModel = process.env.JUDGE_MODEL ?? "opus-4.7";
const threshold = Number(process.env.COVERAGE_THRESHOLD ?? "0.8");

describe(`train rubric coverage [model=${model}]`, () => {
  for (const c of CORPORA) {
    testIfDocker(
      `${c.slug}: covers >= ${Math.round(threshold * 100)}% of must-facts`,
      async () => {
        const rubricPath = rubricPathFor(c);
        if (!existsSync(rubricPath)) {
          throw new Error(
            `Missing rubric ${rubricPath}. Generate it first: ` +
              `bun run evals/scripts/generate-rubrics.ts ${c.slug}`,
          );
        }
        const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as Rubric;

        const result = await runTrainEval({ fixtureDir: fixtureDirFor(c), slug: c.slug, model });
        const grade = await gradeAgainstRubric({
          rubric,
          observation: result.observation.content,
          judgeModel,
        });

        const missed = grade.verdicts
          .filter((v) => v.importance === "must" && !v.covered)
          .map((v) => `  - [${v.id}] ${v.fact} (${v.reason})`);
        console.log(
          `[${model}] ${c.slug}: must ${grade.mustCovered}/${grade.mustTotal} ` +
            `(${(grade.coverage * 100).toFixed(0)}%), nice ${grade.niceCovered}/${grade.niceTotal}` +
            (missed.length ? `\nmissed must-facts:\n${missed.join("\n")}` : ""),
        );

        expect(grade.coverage).toBeGreaterThanOrEqual(threshold);
      },
      300_000,
    );
  }
});
