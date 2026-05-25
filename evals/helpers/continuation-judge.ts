import dedent from "dedent";
import { judge, type JudgeResult } from "../../test/helpers/judge.js";

/**
 * Judges whether an assistant reply continues a specific in-session
 * thread of work or punts with a cold "what next?" greeting.
 *
 * The judge takes the reply plus a short, eval-supplied description
 * of the work that was in flight right before the reply. It returns
 * valid=true ONLY when the reply demonstrably engages with that work
 * (names files, decisions, findings, next steps that belong to the
 * described thread). Generic acknowledgements, polite openers, and
 * "what would you like to work on next?"-shape questions are
 * invalid, even when followed by a list of unrelated capabilities.
 *
 * This judge is consumed by
 * `evals/session-compaction-continues-recent-work.eval.ts`, which
 * drives a real model against the captured wire payload of a session
 * that lost its footing after compaction. While the wire-shaping bug
 * is present the judge must return valid=false; once the fix restores
 * the in-session transcript the same model run should produce a
 * reply that flips it to valid=true.
 */
export interface ContinuesRecentWorkJudgeOptions {
  /** Override the judge model. Defaults to the helper's built-in model. */
  model?: string;
}

export async function judgeContinuesRecentWork(
  input: { reply: string; recentWork: string },
  options: ContinuesRecentWorkJudgeOptions = {},
): Promise<JudgeResult> {
  return judge({
    ...(options.model ? { model: options.model } : {}),
    prompt: dedent`
      You are grading whether an assistant reply continues a specific
      thread of in-session work or punts to a fresh-session opener.

      RECENT WORK describes what the assistant and user were doing in
      the turns immediately before the REPLY. It lists concrete
      anchors — files, symbols, decisions, or findings — that a
      genuine continuation would touch.

      A VALID reply (return valid=true) must do BOTH of:
        (a) reference a specific anchor named in the RECENT WORK —
            a file, symbol, function, commit, eval, or finding —
            AND
        (b) carry the thread forward by EITHER summarizing a
            concrete finding ("the override resolves X because Y"),
            proposing a grounded next step ("next, re-run eval Z to
            confirm"), or asking a specific question whose answer
            only matters to someone inside this thread ("should the
            regression assert API == openai-responses or just
            non-anthropic?").

      Merely naming a file or symbol and then asking the user what
      to do ("We were looking at src/foo.ts. What would you like me
      to do?") is INVALID — it satisfies (a) but punts on (b).

      An INVALID reply (return valid=false) does ANY of:
        - opens with a generic greeting and asks the user to pick a
          topic ("I'm here — what would you like to work on next?",
          "How can I help today?", "Where would you like to start?"),
        - lists capabilities or offers menus that are not tied to
          the RECENT WORK,
        - acknowledges only at the most abstract level ("happy to
          continue") without naming anything from the RECENT WORK,
        - names a concrete anchor but then punts the next move
          back to the user without a finding, step, or specific
          in-thread question.

      Return one concise sentence in 'reason' that names the rule
      that decided the call.
    `,
    value: input,
  });
}
