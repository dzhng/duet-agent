#!/usr/bin/env bun
/**
 * Establish the gold-standard rubrics with the strong expectation-setting
 * model (Opus 4.8 by default), then commit evals/rubrics/<slug>.json.
 *
 * This is step 1 of the model-comparison workflow: "what should good look
 * like?" It needs model credentials (DUET_API_KEY or ANTHROPIC_API_KEY) but
 * does NOT need Docker — it's a plain Opus call over the checked-in corpora.
 *
 *   bun run evals/scripts/generate-rubrics.ts             # all corpora, opus-4.8
 *   RUBRIC_MODEL=opus-4.8 bun run evals/scripts/generate-rubrics.ts vercel-eval
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { CORPORA, RUBRICS_DIR, fixtureDirFor, rubricPathFor } from "../helpers/corpora.js";
import { generateRubric } from "../helpers/rubric.js";

const model = process.env.RUBRIC_MODEL ?? "opus-4.8";
const only = process.argv.slice(2);
const targets = only.length ? CORPORA.filter((c) => only.includes(c.slug)) : CORPORA;

if (targets.length === 0) {
  console.error(`No matching corpora for: ${only.join(", ")}`);
  console.error(`Known slugs: ${CORPORA.map((c) => c.slug).join(", ")}`);
  process.exit(1);
}

mkdirSync(RUBRICS_DIR, { recursive: true });

for (const c of targets) {
  process.stdout.write(`Generating rubric for ${c.slug} with ${model}... `);
  const rubric = await generateRubric({
    slug: c.slug,
    corpus: c.corpus,
    fixtureDir: fixtureDirFor(c),
    model,
  });
  const outPath = rubricPathFor(c);
  writeFileSync(outPath, JSON.stringify(rubric, null, 2) + "\n");
  const must = rubric.facts.filter((f) => f.importance === "must").length;
  console.log(`${rubric.facts.length} facts (${must} must) -> ${outPath}`);
}

console.log("\nDone. Review the rubrics, then commit evals/rubrics/*.json.");
