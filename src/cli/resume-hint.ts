import { basename } from "node:path";
import { shellQuote } from "./shared.js";

/**
 * Inputs needed to recreate the resume command shown after each session.
 * Mirrors the flag surface of `duet` so users can copy-paste verbatim.
 */
export interface ResumeCommandInput {
  modelName?: string;
  memoryModelName?: string;
  workDir: string;
  incognito?: boolean;
  systemInstructions?: string;
  systemPromptFiles?: string[];
  envFilePath?: string;
  resumeHistoryLines?: number;
}

/**
 * Render the shell command that resumes the given session with the same
 * configuration. The invocation prefix matches how the CLI was launched
 * (published bin, `bun run cli`, or `bun src/cli.ts`) so the suggestion
 * works in both production and local-dev shells.
 */
export function resumeCommand(sessionId: string, input: ResumeCommandInput): string {
  const command = [
    detectInvocationPrefix(),
    "--resume",
    shellQuote(sessionId),
    "--workdir",
    shellQuote(input.workDir),
  ];
  if (input.modelName) {
    command.push("--model", shellQuote(input.modelName));
  }
  if (input.memoryModelName) {
    command.push("--memory-model", shellQuote(input.memoryModelName));
  }
  if (input.incognito) {
    command.push("--incognito");
  }
  if (input.systemInstructions) {
    command.push("--system-prompt", shellQuote(input.systemInstructions));
  }
  if (input.systemPromptFiles) {
    if (input.systemPromptFiles.length === 0) {
      command.push("--no-system-prompt-files");
    } else {
      for (const fileName of input.systemPromptFiles) {
        command.push("--system-prompt-file", shellQuote(fileName));
      }
    }
  }
  if (input.envFilePath) {
    command.push("--env-file", shellQuote(input.envFilePath));
  }
  if (input.resumeHistoryLines !== undefined) {
    command.push("--resume-history-lines", String(input.resumeHistoryLines));
  }
  return command.join(" ");
}

/**
 * Detect how this CLI was invoked so the resume hint copy-pastes back into
 * the user's actual shell. `bun run cli` and `bun src/cli.ts` are common
 * during local development; the published bin is `duet`.
 */
function detectInvocationPrefix(): string {
  const scriptPath = process.argv[1] ?? "";
  const base = basename(scriptPath);
  if (process.env.npm_lifecycle_event === "cli") return "bun run cli";
  if (base === "cli.ts" || scriptPath.includes("/src/cli.ts")) return "bun src/cli.ts";
  return "duet";
}
