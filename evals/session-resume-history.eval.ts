import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { SessionManager } from "../src/session/session-manager.js";
import type {
  TurnEvent,
  TurnTerminalEvent,
  TurnUsageEvent,
  TurnUsageFields,
} from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
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
        expect(firstEvents.some((e) => e.type === "usage")).toBe(true);

        const usageSnap = firstSession.getLastUsage();
        expect(usageSnap).toBeDefined();
        expect(usageSnap!.effectiveContextWindow).toBeGreaterThan(0);
        expect(usageSnap!.usage.totalTokens).toBeGreaterThan(0);
        const cw = usageSnap!.contextWindowUsage;
        // Breakdown rescales to the latest parent message's `totalTokens`,
        // which is at most the running aggregate (the aggregate also folds
        // in memory-observer work when it runs). The exact rescale math is
        // covered by the `scaleContextWindowUsageToTotalTokens` unit tests.
        const breakdownSum = cw.systemPrompt + cw.messages + cw.localMemory + cw.globalMemory;
        expect(breakdownSum).toBeGreaterThan(0);
        expect(breakdownSum).toBeLessThanOrEqual(usageSnap!.usage.totalTokens);
      } finally {
        await firstManager.dispose();
      }

      const diskAfterFirst = await readSessionStateJson(sessionStoragePath, sessionId);
      assertSessionCostMatchesTerminal(diskAfterFirst, firstTerminal);
      expect(diskAfterFirst.lastUsage).toBeDefined();
      expect(diskAfterFirst.state).toBeDefined();
      expectDiskUsageMatchesLastEvent(diskAfterFirst, firstEvents);

      const firstDiskUsage = diskAfterFirst.lastUsage as TurnUsageFields;
      expect(firstDiskUsage.usage.totalTokens).toBeGreaterThan(0);

      let secondTerminal: TurnTerminalEvent;
      const secondEvents: TurnEvent[] = [];
      let expectedCumulativeUsd = Number.NaN;
      const secondManager = createManager(sessionStoragePath);
      try {
        const resumedSession = secondManager.resume(sessionId);
        const unsubSecond = resumedSession.subscribe((event) => {
          secondEvents.push(event);
        });
        await resumedSession.start();
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
        expect(secondEvents.some((e) => e.type === "usage")).toBe(true);

        const secondTurnCost = terminalUsageCostUsd(secondTerminal);
        expect(secondTurnCost).toBeGreaterThan(0);

        expectedCumulativeUsd =
          terminalUsageCostUsd(firstTerminal) + terminalUsageCostUsd(secondTerminal);

        const diskBeforeSecondDispose = await readSessionStateJson(sessionStoragePath, sessionId);
        expect(diskBeforeSecondDispose.sessionCostUsd).toBeCloseTo(expectedCumulativeUsd, 4);
        expect(diskBeforeSecondDispose.lastUsage).toBeDefined();
        expectDiskUsageMatchesLastEvent(diskBeforeSecondDispose, secondEvents);
      } finally {
        await secondManager.dispose();
      }

      expect(Number.isFinite(expectedCumulativeUsd)).toBe(true);

      const diskFinal = await readSessionStateJson(sessionStoragePath, sessionId);
      expect(diskFinal.sessionCostUsd).toBeCloseTo(expectedCumulativeUsd, 4);
      expect(diskFinal.lastUsage).toBeDefined();
      expectDiskUsageMatchesLastEvent(diskFinal, secondEvents);

      const secondDiskUsage = diskFinal.lastUsage as TurnUsageFields;
      // Each turn resets the runner's running aggregate, so the per-turn
      // `usage.totalTokens` is independent across turns; what's monotonic is
      // the persisted cumulative cost on disk, asserted above.
      expect(secondDiskUsage.usage.totalTokens).toBeGreaterThan(0);

      // The persisted snapshot is the last `usage` event of the latest turn,
      // which in turn always matches the terminal's running aggregate.
      if (secondTerminal.usage?.totalTokens != null) {
        expect(secondDiskUsage.usage.totalTokens).toBe(secondTerminal.usage.totalTokens);
      }

      // The resumed turn has strictly more conversation than the first, so
      // its rescaled `messages` share must grow. Other segments come from
      // roughly constant raw inputs (system prompt + memory) whose rescaled
      // shares can shrink as `messages` claims more of the denominator —
      // so we don't compare those across turns.
      const a = firstDiskUsage.contextWindowUsage;
      const b = secondDiskUsage.contextWindowUsage;
      expect(b.messages).toBeGreaterThan(a.messages);
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
  lastUsage?: TurnUsageFields;
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

function lastUsageFromEvents(events: TurnEvent[]): TurnUsageEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "usage") return e;
  }
  return undefined;
}

/**
 * Persisted `lastUsage` on `state.json` must match the last live `usage`
 * event from the same phase exactly — same running aggregate, same
 * effective window, same breakdown snapshot. The rescaled breakdown
 * itself is exercised by `scaleContextWindowUsageToTotalTokens` unit
 * tests; here we just check the disk vs event invariant.
 */
function expectDiskUsageMatchesLastEvent(disk: SessionStateJson, events: TurnEvent[]): void {
  const fromDisk = disk.lastUsage;
  expect(fromDisk).toBeDefined();
  expect(fromDisk!.usage.totalTokens).toBeGreaterThan(0);
  const seg = fromDisk!.contextWindowUsage;
  const segSum = seg.systemPrompt + seg.messages + seg.localMemory + seg.globalMemory;
  expect(segSum).toBeGreaterThan(0);
  expect(segSum).toBeLessThanOrEqual(fromDisk!.usage.totalTokens);

  const fromEvents = lastUsageFromEvents(events);
  if (!fromEvents) {
    throw new Error("expected at least one usage event in this phase");
  }

  expect(fromDisk!.usage).toEqual(fromEvents.usage);
  expect(fromDisk!.effectiveContextWindow).toBe(fromEvents.effectiveContextWindow);
  expect(fromDisk!.contextWindowUsage).toEqual(fromEvents.contextWindowUsage);
}
