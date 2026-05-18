import dedent from "dedent";
import { judge, type JudgeResult } from "../../test/helpers/judge.js";

/**
 * Domain-specific judges for global-reflection row quality.
 *
 * Each judge wraps `judge()` with a tightly-scoped grading prompt for
 * one semantic property of a reflection row. The judges are exercised
 * by `evals/reflection-judge.eval.ts` against hand-crafted positive
 * and negative fixtures BEFORE the unit-reflection eval consumes
 * them, so a judge that drifts (over-strict, under-strict, or fooled
 * by a particular phrasing) is caught against known-answer cases
 * rather than against the LLM's live reflector output.
 *
 * If you tighten or loosen a judge prompt here, the corresponding
 * judge-eval cases MUST be updated alongside — a judge with no
 * fixture coverage is not safe to use as a grader.
 */

export interface ReflectionJudgeOptions {
  /** Override the judge model. Defaults to the helper's built-in model. */
  model?: string;
}

/**
 * Judges whether every row in `rows` reads as a self-contained
 * mini-narrative: trigger → journey → decision → rationale/lesson.
 * Bare-headline rows ("X was fixed on Y", "v1.2.3 was released") are
 * invalid. The judge tolerates one or two thin rows in a larger set;
 * the failure threshold is "at least 80% of rows are narratives".
 */
export async function judgeNarrativeShape(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      You are grading reflection rows persisted to a long-term agent
      memory store. Each row must be readable cold by a future agent
      who has never seen the original conversation, so each row must
      be a SELF-CONTAINED MINI-NARRATIVE that captures:

        - the trigger or symptom that surfaced the work,
        - the path taken (what was tried, ruled out, or considered),
        - the decision or outcome with concrete identifiers (dates,
          file paths, commit SHAs, version tags, package names), AND
        - the rationale or higher-level lesson explaining WHY this
          was the right call.

      Bare-headline rows ("X was fixed on Y", "v1.2.3 was released",
      "CI passed twice") are INVALID — they state the outcome
      without the journey. A valid row tells a small story with
      cause and effect.

      Return valid=true ONLY when AT LEAST 80% of the rows below are
      full mini-narratives by the criteria above. Return valid=false
      (with a one-sentence reason naming the failing rows by index)
      when the bulk are bare headlines.
    `,
    value: { rows },
  });
}

/**
 * Judges whether every row contains at least one concrete identifier
 * that a future agent could grep for or recognize (date, PR/issue
 * number, commit SHA, version tag, file path, package name,
 * function/symbol, env var, or a quoted error string). Common English
 * words alone don't count.
 */
export async function judgeConcreteIdentifiers(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      Each row below comes from a long-term agent memory store. For
      the row to be findable again by a future agent, it must include
      AT LEAST ONE concrete identifier the agent could grep for or
      recognize: a date (YYYY-MM-DD), PR or issue number, commit SHA
      (7+ hex chars), version tag (v1.2.3, ^1.2.3, 1.2.3-beta),
      file path, package name, function/symbol name, environment
      variable, or a verbatim quoted error string. A row whose only
      specifics are common English words is INVALID.

      Return valid=true ONLY when EVERY row contains at least one
      such identifier. Return valid=false (with a one-sentence reason
      naming the offending rows by index) when any row is
      identifier-free.
    `,
    value: { rows },
  });
}

/**
 * Judges whether any pair of rows covers the same distinct insight.
 * Two rows are duplicates when they capture the same underlying
 * cause→fix story, decision, or lesson — even if wording, level of
 * detail, or chosen identifiers differ. Two rows on the same broader
 * topic that capture DIFFERENT specific decisions are not duplicates.
 */
export async function judgeDistinctInsights(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      Each row below is supposed to be one distinct durable insight.
      Two rows are DUPLICATES when they cover the same underlying
      insight (same cause→fix story, same decision, same lesson) —
      even if the wording, level of detail, or chosen identifiers
      differ. Two rows that touch the same broader topic but capture
      DIFFERENT specific decisions or lessons are NOT duplicates.

      Return valid=true when NO pair of rows is a duplicate. Return
      valid=false (with a one-sentence reason naming the duplicate
      rows by index) when at least one pair covers the same insight.
    `,
    value: { rows },
  });
}
