import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "vercel-ai-gateway:anthropic/claude-sonnet-4.6";
const resumeToken = "mango-ocean-742";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("session resume history", () => {
  testIfDocker(
    "answers from message history after resuming persisted session state",
    async () => {
      const sessionStoragePath = await mkdtemp(join(tmpdir(), "duet-session-resume-eval-"));
      tempDirs.push(sessionStoragePath);
      const sessionId = "resume-history-eval";

      const firstManager = createManager(sessionStoragePath);
      try {
        const firstSession = firstManager.create({ sessionId, mode: "agent" });
        await firstSession.prompt({
          message: `Remember this exact session token for the next turn: ${resumeToken}. Reply with exactly: stored.`,
        });
        const firstTerminal = await firstSession.waitForTerminal();
        expect(firstTerminal.type).toBe("complete");
        expect(firstTerminal.type === "complete" ? firstTerminal.status : undefined).toBe(
          "completed",
        );
      } finally {
        await firstManager.dispose();
      }

      const secondManager = createManager(sessionStoragePath);
      try {
        const resumedSession = secondManager.resume(sessionId);
        await resumedSession.start();
        await resumedSession.prompt({
          message: "What exact session token did I ask you to remember? Reply with only the token.",
        });
        const terminal = await resumedSession.waitForTerminal();

        expect(terminal.type).toBe("complete");
        expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");
        expect(terminal.type === "complete" ? terminal.result : "").toContain(resumeToken);
      } finally {
        await secondManager.dispose();
      }
    },
    30_000,
  );
});

function createManager(sessionStoragePath: string): SessionManager {
  return new SessionManager(
    {
      model,
      mode: "agent",
      skillDiscovery: { includeDefaults: false },
      systemPromptFiles: [],
      systemInstructions:
        "Do not call tools. Follow the user's requested output format exactly and rely on the conversation history when asked about it.",
    },
    { sessionStoragePath },
  );
}
