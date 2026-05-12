import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import type { TurnContextUsageEvent, TurnEvent, TurnTerminalEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const resumeToken = "mango-ocean-742";

type PersistedContextUsage = Omit<TurnContextUsageEvent, "type">;

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

      let firstTerminal: TurnTerminalEvent;
      const firstEvents: TurnEvent[] = [];
      const firstManager = createManager(sessionStoragePath);
      try {
        const firstSession = firstManager.create({ sessionId, mode: "agent" });
        const unsubFirst = firstSession.subscribe((event) => {
          firstEvents.push(event);
        });
        await firstSession.prompt({
          message: `Remember this exact session token for the next turn: ${resumeToken}. Reply with exactly: stored.`,
        });
        const ft = await firstSession.waitForTerminal();
        unsubFirst();

        expect(ft.type).toBe("complete");
        if (ft.type !== "complete") throw new Error("expected complete");
        firstTerminal = ft;
        expect(firstTerminal.status).toBe("completed");
        expect(firstEvents.some((e) => e.type === "turn_started")).toBe(true);
        expect(firstEvents.some((e) => e.type === "context_usage")).toBe(true);

        const contextSnap = firstSession.getLastContextUsage();
        expect(contextSnap).toBeDefined();
        expect(contextSnap!.effectiveContextWindow).toBeGreaterThan(0);
        expect(contextSnap!.usage.totalTokens).toBeGreaterThan(0);
        const cw = contextSnap!.contextWindowUsage;
        expect(cw.systemPrompt + cw.messages + cw.localMemory + cw.globalMemory).toBe(
          contextSnap!.usage.totalTokens,
        );
      } finally {
        await firstManager.dispose();
      }

      const diskAfterFirst = await readSessionStateJson(sessionStoragePath, sessionId);
      assertSessionCostMatchesTerminal(diskAfterFirst, firstTerminal);
      expect(diskAfterFirst.lastContextUsage).toBeDefined();
      expect(diskAfterFirst.state).toBeDefined();
      expectDiskContextMatchesLastEvent(diskAfterFirst, firstEvents);

      const firstDiskContext = diskAfterFirst.lastContextUsage as PersistedContextUsage;
      expect(firstDiskContext.usage.totalTokens).toBeGreaterThan(0);

      let secondTerminal: TurnTerminalEvent;
      const secondEvents: TurnEvent[] = [];
      let expectedCumulativeUsd = Number.NaN;
      const secondManager = createManager(sessionStoragePath);
      try {
        const resumedSession = secondManager.resume(sessionId);
        await resumedSession.start();
        const unsubSecond = resumedSession.subscribe((event) => {
          secondEvents.push(event);
        });
        await resumedSession.prompt({
          message: "What exact session token did I ask you to remember? Reply with only the token.",
        });
        const st = await resumedSession.waitForTerminal();
        unsubSecond();

        expect(st.type).toBe("complete");
        if (st.type !== "complete") throw new Error("expected complete");
        secondTerminal = st;
        expect(secondTerminal.status).toBe("completed");
        expect(secondTerminal.type === "complete" ? secondTerminal.result : "").toContain(
          resumeToken,
        );

        expect(secondEvents.some((e) => e.type === "turn_started")).toBe(true);
        expect(secondEvents.some((e) => e.type === "context_usage")).toBe(true);

        const secondTurnCost = terminalUsageCostUsd(secondTerminal);
        expect(secondTurnCost).toBeGreaterThan(0);

        expectedCumulativeUsd =
          terminalUsageCostUsd(firstTerminal) + terminalUsageCostUsd(secondTerminal);

        const diskBeforeSecondDispose = await readSessionStateJson(sessionStoragePath, sessionId);
        expect(diskBeforeSecondDispose.sessionCostUsd).toBeCloseTo(expectedCumulativeUsd, 4);
        expect(diskBeforeSecondDispose.lastContextUsage).toBeDefined();
        expectDiskContextMatchesLastEvent(diskBeforeSecondDispose, secondEvents);
      } finally {
        await secondManager.dispose();
      }

      expect(Number.isFinite(expectedCumulativeUsd)).toBe(true);

      const diskFinal = await readSessionStateJson(sessionStoragePath, sessionId);
      expect(diskFinal.sessionCostUsd).toBeCloseTo(expectedCumulativeUsd, 4);
      expect(diskFinal.lastContextUsage).toBeDefined();
      expectDiskContextMatchesLastEvent(diskFinal, secondEvents);

      const secondDiskContext = diskFinal.lastContextUsage as PersistedContextUsage;
      expect(secondDiskContext.usage.totalTokens).toBeGreaterThanOrEqual(
        firstDiskContext.usage.totalTokens,
      );

      // `context_usage.usage.totalTokens` is full-window occupancy after that assistant
      // message, not `turn1.totalTokens + turn2.totalTokens` (that would double-count).
      if (secondTerminal.usage?.totalTokens != null) {
        expect(secondDiskContext.usage.totalTokens).toBe(secondTerminal.usage.totalTokens);
      }

      const a = firstDiskContext.contextWindowUsage;
      const b = secondDiskContext.contextWindowUsage;
      expect(b.messages).toBeGreaterThan(a.messages);
      expect(b.systemPrompt).toBeGreaterThanOrEqual(a.systemPrompt);
      expect(b.localMemory).toBeGreaterThanOrEqual(a.localMemory);
      expect(b.globalMemory).toBeGreaterThanOrEqual(a.globalMemory);
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

/** Mirrors `SessionManager` / `Session` session directory naming. */
function sessionDir(sessionStoragePath: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(sessionStoragePath, safe);
}

interface SessionStateJson {
  sessionId?: string;
  updatedAt?: number;
  state?: unknown;
  lastContextUsage?: PersistedContextUsage;
  sessionCostUsd?: number;
}

async function readSessionStateJson(
  sessionStoragePath: string,
  sessionId: string,
): Promise<SessionStateJson> {
  const path = join(sessionDir(sessionStoragePath, sessionId), "state.json");
  const text = await readFile(path, "utf-8");
  return JSON.parse(text) as SessionStateJson;
}

function terminalUsageCostUsd(terminal: TurnTerminalEvent): number {
  const t = terminal.usage?.cost?.total;
  if (typeof t !== "number" || !Number.isFinite(t)) {
    return Number.NaN;
  }
  return t;
}

function assertSessionCostMatchesTerminal(
  disk: SessionStateJson,
  terminal: TurnTerminalEvent,
): void {
  expect(typeof disk.sessionCostUsd).toBe("number");
  expect(Number.isFinite(disk.sessionCostUsd)).toBe(true);
  const expected = terminalUsageCostUsd(terminal);
  expect(expected).toBeGreaterThan(0);
  expect(disk.sessionCostUsd).toBeCloseTo(expected, 6);
}

function lastContextUsageFromEvents(events: TurnEvent[]): TurnContextUsageEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "context_usage") return e;
  }
  return undefined;
}

/**
 * Persisted `lastContextUsage` on `state.json` must match the last live
 * `context_usage` event from the same phase when any such events were recorded.
 * Asserts every `contextWindowUsage` segment (`systemPrompt`, `messages`,
 * `localMemory`, `globalMemory`) matches the wire event and sums to `totalTokens`.
 */
function expectDiskContextMatchesLastEvent(disk: SessionStateJson, events: TurnEvent[]): void {
  const fromDisk = disk.lastContextUsage;
  expect(fromDisk).toBeDefined();
  const u = fromDisk!.usage;
  expect(u.totalTokens).toBeGreaterThan(0);
  const seg = fromDisk!.contextWindowUsage;
  expect(seg.systemPrompt + seg.messages + seg.localMemory + seg.globalMemory).toBe(u.totalTokens);

  const fromEvents = lastContextUsageFromEvents(events);
  if (!fromEvents) {
    throw new Error("expected at least one context_usage event in this phase");
  }

  expect(fromDisk!.usage).toEqual(fromEvents.usage);
  expect(fromDisk!.effectiveContextWindow).toBe(fromEvents.effectiveContextWindow);
  expect(fromDisk!.contextWindowUsage).toEqual(fromEvents.contextWindowUsage);
}
