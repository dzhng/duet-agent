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
 * Judges whether every project-specific row names the project it
 * belongs to (repo, package, monorepo path, product surface), so the
 * row stays meaningful when read back from a different working
 * directory weeks later. Rows that are clearly user-level facts
 * (preferences, personal info, schedule) do not need a project
 * anchor and don't count against the verdict.
 */
export async function judgeProjectContext(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      Each row below comes from a long-term agent memory store that
      spans many sessions and many working directories. For a
      project-specific row to remain useful when read back from a
      different repo, it must NAME THE PROJECT it belongs to — the
      repo name, monorepo path, package name, or product surface
      — inside the row's own prose. Generic file paths like
      \`src/foo.ts\` or \`package.json\` are NOT enough on their
      own because every repo has those; the row must also identify
      which repo / product.

      A row counts as project-specific when it describes code,
      tests, CI, releases, infra, or anything else that lives inside
      a particular codebase. A row about user preferences, personal
      info, schedule, or general non-code work is NOT
      project-specific and does NOT need a project anchor — ignore
      it when grading.

      Return valid=true ONLY when EVERY project-specific row names
      its project / repo / package. Return valid=false (with a
      one-sentence reason naming the offending rows by index) when
      any project-specific row leaves the project ambiguous.
    `,
    value: { rows },
  });
}

/**
 * Judges whether each user steer / push-back / approval listed in
 * `steers` is preserved by AT LEAST ONE reflection row (verbatim, as
 * a near-quote, or as a clear paraphrase that names the user's
 * intent). User steers are the highest-signal precedent in the
 * decision graph — they override defaults and reset the rule going
 * forward — so losing them through reflection is the most expensive
 * failure mode for cross-session memory.
 */
export async function judgeUserSteersPreserved(
  rows: readonly string[],
  steers: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      The following STEERS are statements the user made during the
      original conversation that overrode defaults, redirected the
      work, vetoed a path, or approved an exception. Each one is
      durable precedent the agent should remember verbatim or as a
      faithful paraphrase. The ROWS below are the reflection memory
      the agent will see weeks from now.

      Return valid=true ONLY when EVERY steer is preserved by AT
      LEAST ONE row — either as a quoted snippet, a near-quote, or
      a paraphrase that clearly names the user's intent and is
      attributed to the user ("per the user's direction…", "the
      user pushed back that…", "the user explicitly approved…").
      A row that captures the OUTCOME of acting on a steer but
      strips the steer itself does NOT count — the precedent value
      comes from knowing the user's wording / framing.

      Return valid=false (with a one-sentence reason naming the
      missing steers by index) when any steer is not preserved.
    `,
    value: { steers, rows },
  });
}

/**
 * Judges whether decision rows record at least one alternative
 * considered and rejected, not just the chosen outcome. Foundation
 * Capital's "Context Graphs" piece
 * (https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity)
 * treats conflict resolution as a first-class part of decision
 * traces — rejected options carry as much precedent weight as chosen
 * ones for future agents weighing the same call.
 *
 * Rows that are pure user-facts (preferences, schedule) don't have
 * decisions and are excluded from the denominator.
 */
export async function judgeAlternativesConsidered(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      Each row below is a reflection memory. Identify which rows
      record an engineering or product DECISION (a path chosen, a
      fix landed, an approach picked, an option weighed). Pure
      user-fact rows (preferences, personal info, schedule) are
      NOT decisions and should be ignored when grading.

      A decision row is COMPLETE only when it surfaces at least one
      alternative that was considered and rejected, dropped, or
      weighed against the chosen path. Phrasings that count include:
      "tried X first, dropped it because…", "considered Y but…",
      "rejected Z in favor of…", "weighed A vs B and picked A
      because…", "earlier approach was… then switched to…". A row
      that only states the chosen outcome ("the fix is X", "X was
      released") without any rejected alternative is INCOMPLETE.

      Return valid=true when AT LEAST 50% of decision rows record
      at least one alternative. Return valid=false (with a
      one-sentence reason naming the offending rows by index) when
      the bulk are outcome-only.
    `,
    value: { rows },
  });
}

/**
 * Judges whether every decision row attributes the decision to a
 * concrete source: a user steer, a project convention or rule
 * (AGENTS.md, skill instruction), a prior precedent or memory, an
 * observed symptom / error, or an explicit "no precedent — fresh
 * judgement call". Decisions with no attribution are dead-ends in
 * the precedent graph because the future agent can't tell whether to
 * generalize, replicate, or revisit the call.
 */
export async function judgeDecisionAttribution(
  rows: readonly string[],
  options: ReflectionJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      Each row below is a reflection memory. For rows that record
      an engineering or product DECISION (a path chosen, a fix
      landed, an approach picked), the row must ATTRIBUTE the
      decision to a concrete source. Valid attributions include:

        - a user steer / push-back / approval ("per the user's
          direction…", "the user explicitly chose…"),
        - a project convention or rule ("per AGENTS.md…",
          "following the skill's guidance…"),
        - a prior precedent / earlier memory ("following the
          earlier fix for X…", "consistent with the previous
          decision on Y…"),
        - an observed symptom / error / measurement that forced
          the path ("because the test surfaced X…", "to resolve
          the Y race…"),
        - an explicit "no precedent — fresh judgement call"
          framing.

      A decision row with NO attribution — just an outcome stated
      in passive voice ("X was changed to Y", "v1.2.3 was
      released") — is INVALID. Pure user-fact rows are not
      decisions and don't need attribution.

      Return valid=true ONLY when EVERY decision row attributes
      its decision to one of the sources above. Return valid=false
      (with a one-sentence reason naming the offending rows by
      index) when any decision row is unattributed.
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
