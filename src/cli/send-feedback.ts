import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { submitDuetFeedback } from "../lib/feedback.js";
import { printSendFeedbackHelp } from "./help.js";
import { fail, isInteractive, resolveUserPath } from "./shared.js";

export interface SendFeedbackCommandIO {
  cwd?: string;
  /** Inject a stand-in for the readline-backed prompt so tests can drive it. */
  promptForFeedback?: () => Promise<string>;
  /** Inject a stand-in for fetch so tests can intercept the upload. */
  fetch?: typeof fetch;
}

/**
 * Run `duet send-feedback`.
 *
 * Submits a piece of free-form markdown feedback to the Duet API's public
 * feedback endpoint. No API key required — the endpoint is intentionally
 * unauthenticated so external clients can drop notes into the team's triage
 * queue without a login.
 *
 * Content sources, in priority order:
 *   1. Positional argument (e.g. `duet send-feedback "thing is broken"`)
 *   2. `--file <path>` (read markdown from a file)
 *   3. stdin if piped
 *   4. Interactive prompt
 */
export async function runSendFeedbackCommand(
  args: string[],
  io: SendFeedbackCommandIO = {},
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  let filePath: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--file":
      case "-f":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        filePath = args[++i]!;
        break;
      case "--help":
      case "-h":
        printSendFeedbackHelp();
        return;
      default: {
        const arg = args[i]!;
        if (arg.startsWith("-")) fail(`Unknown send-feedback option: ${arg}`);
        positional.push(arg);
      }
    }
  }

  let content = positional.join(" ").trim();

  if (!content && filePath) {
    content = (await readFile(resolveUserPath(filePath, cwd), "utf8")).trim();
  }

  if (!content && !process.stdin.isTTY) {
    content = (await readStdin()).trim();
  }

  if (!content) {
    if (!isInteractive()) {
      fail("No feedback provided. Pass it as an argument, via --file, or pipe it on stdin.");
    }
    content = (await (io.promptForFeedback ?? promptForFeedback)()).trim();
  }

  if (!content) {
    fail("Feedback content is required.");
  }

  try {
    const { baseUrl } = await submitDuetFeedback({ content, fetch: io.fetch });
    console.error(`Thanks! Feedback sent to ${baseUrl}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function promptForFeedback(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    console.error("Type your feedback (markdown). Submit an empty line to send.");
    const lines: string[] = [];
    while (true) {
      const line = await rl.question("> ");
      if (line.length === 0) break;
      lines.push(line);
    }
    return lines.join("\n");
  } finally {
    rl.close();
  }
}
