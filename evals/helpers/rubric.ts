import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";

import { generateStructuredOutput } from "../../src/core/structured-output.js";

/**
 * Gold-standard rubric for a train corpus. Generated once by the strong
 * "expectation-setting" model (Opus 4.8) and committed to the repo, then
 * used to grade how well cheaper models capture the same essentials.
 *
 * A `fact` is one atomic, independently checkable claim that a good
 * synthesis of the corpus MUST surface. `importance: "must"` facts count
 * toward the pass threshold; `"nice"` facts are tracked but not required.
 */
export interface RubricFact {
  id: string;
  fact: string;
  importance: "must" | "nice";
}

export interface Rubric {
  slug: string;
  corpus: string;
  generatedBy: string;
  facts: RubricFact[];
}

const factSchema = Type.Object({
  facts: Type.Array(
    Type.Object({
      id: Type.String({ description: "Stable short id like f1, f2, ..." }),
      fact: Type.String({
        description:
          "One atomic, independently verifiable claim grounded in the corpus that a good memory synthesis MUST capture.",
      }),
      importance: Type.Union([Type.Literal("must"), Type.Literal("nice")], {
        description:
          "'must' = core fact required for a passing synthesis; 'nice' = valuable but not required.",
      }),
    }),
    { minItems: 5, maxItems: 14 },
  ),
});

const factTool: Tool<typeof factSchema> = {
  name: "emitRubric",
  description: "Emit the checklist of must-capture facts for this corpus.",
  parameters: factSchema,
};

const gradeSchema = Type.Object({
  verdicts: Type.Array(
    Type.Object({
      id: Type.String({ description: "The rubric fact id being judged." }),
      covered: Type.Boolean({
        description:
          "True only if the observation conveys this fact (paraphrase is fine; do not credit vague gestures).",
      }),
      reason: Type.String({ description: "One concise sentence justifying the verdict." }),
    }),
  ),
});

const gradeTool: Tool<typeof gradeSchema> = {
  name: "gradeObservation",
  description: "Judge which rubric facts the observation covers.",
  parameters: gradeSchema,
};

/** Read every substantive file in a corpus fixture into one labelled blob. */
export function readCorpus(fixtureDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (/\.(md|markdown|txt|csv|json)$/i.test(entry.name)) {
        parts.push(`===== FILE: ${relPath} =====\n${readFileSync(abs, "utf8")}`);
      }
    }
  };
  walk(fixtureDir, "");
  return parts.join("\n\n");
}

/**
 * Establish the gold-standard rubric for a corpus using the strong
 * expectation-setting model. Run once per corpus; the result is committed
 * as evals/rubrics/<slug>.json.
 */
export async function generateRubric(input: {
  slug: string;
  corpus: string;
  fixtureDir: string;
  model: string;
}): Promise<Rubric> {
  const corpusText = readCorpus(input.fixtureDir);
  const result = await generateStructuredOutput({
    model: input.model,
    tool: factTool,
    systemPrompt: [
      "You are setting the gold-standard expectation for what a durable memory",
      "synthesis of a project corpus MUST capture. Read the corpus and produce a",
      "checklist of atomic, independently verifiable facts. Each fact must be",
      "specific and grounded in the corpus (a cheaper model could not state it",
      "without having read this material). Mark the load-bearing essentials as",
      "'must' and genuinely-useful-but-optional details as 'nice'. Prefer 6-10",
      "'must' facts. Do not invent facts not supported by the corpus.",
    ].join(" "),
    prompt: `CORPUS (slug: ${input.slug}):\n\n${corpusText}`,
  });
  return {
    slug: input.slug,
    corpus: input.corpus,
    generatedBy: input.model,
    facts: result.facts,
  };
}

export interface GradeResult {
  mustTotal: number;
  mustCovered: number;
  niceTotal: number;
  niceCovered: number;
  /** mustCovered / mustTotal, in [0,1]. */
  coverage: number;
  verdicts: Array<{
    id: string;
    fact: string;
    importance: "must" | "nice";
    covered: boolean;
    reason: string;
  }>;
}

/**
 * Grade one synthesized observation against a committed rubric using an
 * independent judge model. Coverage is the fraction of 'must' facts the
 * observation conveys.
 */
export async function gradeAgainstRubric(input: {
  rubric: Rubric;
  observation: string;
  judgeModel: string;
}): Promise<GradeResult> {
  const { rubric } = input;
  const factList = rubric.facts.map((f) => `[${f.id}] (${f.importance}) ${f.fact}`).join("\n");

  const result = await generateStructuredOutput({
    model: input.judgeModel,
    tool: gradeTool,
    systemPrompt:
      "You are a strict grader. For each rubric fact, decide whether the OBSERVATION conveys it. " +
      "Accept faithful paraphrases; reject vague gestures, hedging, or facts merely implied. " +
      "Emit exactly one verdict per rubric fact id.",
    prompt: `RUBRIC FACTS:\n${factList}\n\nOBSERVATION:\n${input.observation}`,
  });

  const byId = new Map(result.verdicts.map((v) => [v.id, v]));
  const verdicts = rubric.facts.map((f) => {
    const v = byId.get(f.id);
    return {
      id: f.id,
      fact: f.fact,
      importance: f.importance,
      covered: v?.covered ?? false,
      reason: v?.reason ?? "no verdict returned for this fact",
    };
  });

  const must = verdicts.filter((v) => v.importance === "must");
  const nice = verdicts.filter((v) => v.importance === "nice");
  const mustCovered = must.filter((v) => v.covered).length;
  const niceCovered = nice.filter((v) => v.covered).length;

  return {
    mustTotal: must.length,
    mustCovered,
    niceTotal: nice.length,
    niceCovered,
    coverage: must.length === 0 ? 1 : mustCovered / must.length,
    verdicts,
  };
}

export type RubricFactStatic = Static<typeof factSchema>["facts"][number];
