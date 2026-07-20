import dedent from "dedent";

import type { ManifestEntry } from "./manifest.js";

/** Identical system instruction used by every arm to make advisor exposure deterministic. */
export const SWEBENCH_SYSTEM_PROMPT = dedent`
  SWE-BENCH TREATMENT RULES

  Follow the task prompt's advisor instruction literally. If an \`ask_advisor\` tool is
  available, one consultation is mandatory for this benchmark even when the task appears routine
  or obvious. You may first inspect the repository with read-only commands, then you must call
  \`ask_advisor\` exactly once before any command that changes repository files. Do not call it a
  second time. If the tool is unavailable, continue without it.

  Keep validation non-interactive. Before finishing, inspect the final git status and remove every
  test fixture, cache, benchmark artifact, and runtime file created during the turn. Submit only
  the production implementation needed for the issue.
`;

/** Immutable issue input shared byte-for-byte by every arm for one instance. */
export interface RolloutPromptInput {
  /** Manifest identity used only to make the task boundary explicit. */
  entry: ManifestEntry;
  /** Canonical `problem_statement` from the pinned dataset revision. */
  problemStatement: string;
}

/** Build the campaign's unattended prompt shared byte-for-byte by every arm. */
export function buildRolloutPrompt(input: RolloutPromptInput): string {
  if (!input.problemStatement.trim()) {
    throw new Error(`Problem statement is empty for ${input.entry.instanceId}.`);
  }
  return dedent`
    You are fixing SWE-bench instance ${input.entry.instanceId} in the repository at /testbed.

    Work directly in /testbed and continue unattended until you have implemented the best complete fix you can. Inspect the repository, edit the implementation, and run relevant tests or checks. Do not ask the user questions. Do not commit changes. Do not modify existing tests or benchmark/runtime files.

    If an ask_advisor tool is available, call it exactly once after your initial inspection and before making implementation edits. If that tool is unavailable, continue normally without it. In either case, make and verify the final implementation with your own judgment.

    Before finishing, revert any test, cache, benchmark, or runtime files changed during your work so the final patch contains only the production implementation needed for the fix.

    The required fix is:

    ${input.problemStatement.trim()}
  `;
}
