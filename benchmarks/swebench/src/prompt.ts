import dedent from "dedent";

import type { ManifestEntry } from "./manifest.js";

/** Minimal unattended-run contract shared byte-for-byte by every arm. */
export const SWEBENCH_SYSTEM_PROMPT = dedent`
  Complete the SWE-bench task unattended in /testbed.
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

    Inspect the repository, implement the best complete fix you can, and run relevant tests or checks. Do not ask the user questions.

    The required fix is:

    ${input.problemStatement.trim()}
  `;
}
