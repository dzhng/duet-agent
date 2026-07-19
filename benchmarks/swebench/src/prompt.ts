import dedent from "dedent";

import type { ManifestEntry } from "./manifest.js";

/** Immutable issue input shared byte-for-byte by every arm for one instance. */
export interface RolloutPromptInput {
  /** Manifest identity used only to make the task boundary explicit. */
  entry: ManifestEntry;
  /** Canonical `problem_statement` from the pinned dataset revision. */
  problemStatement: string;
}

/** Build campaign 1's frozen, unattended coding prompt. */
export function buildRolloutPrompt(input: RolloutPromptInput): string {
  if (!input.problemStatement.trim()) {
    throw new Error(`Problem statement is empty for ${input.entry.instanceId}.`);
  }
  return dedent`
    You are fixing SWE-bench instance ${input.entry.instanceId} in the repository at /testbed.

    Work directly in /testbed and continue unattended until you have implemented the best complete fix you can. Inspect the repository, edit the implementation, and run relevant tests or checks. Do not ask the user questions. Do not commit changes. Do not modify existing tests or benchmark/runtime files.

    The required fix is:

    ${input.problemStatement.trim()}
  `;
}
