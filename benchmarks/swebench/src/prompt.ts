import dedent from "dedent";

/** Minimal unattended-run contract shared byte-for-byte by every arm. */
export const SWEBENCH_SYSTEM_PROMPT = dedent`
  Resolve the task in the repository and leave the working tree with the complete solution. Work unattended.
`;

/** Canonical issue input shared byte-for-byte by every arm for one instance. */
export interface RolloutPromptInput {
  /** Canonical `problem_statement` from the pinned dataset revision. */
  problemStatement: string;
}

/** Return the dataset issue verbatim apart from surrounding whitespace. */
export function buildRolloutPrompt(input: RolloutPromptInput): string {
  if (!input.problemStatement.trim()) {
    throw new Error("Problem statement is empty.");
  }
  return input.problemStatement.trim();
}
