import type { TurnEvent } from "../../../src/types/protocol.js";
import { deriveTelemetry, type RolloutTelemetry } from "../../shared/rollout-telemetry.js";
import type { RolloutOutcome } from "../../shared/duet-rpc-client.js";

/** Compact metrics Pier records beside DeepSWE's authoritative reward. */
export interface DeepSweRunSummary {
  schemaVersion: 1;
  terminal: RolloutTelemetry["terminalStatus"] | "killed";
  timedOut: boolean;
  killedReason?: RolloutOutcome["killedReason"];
  wallClockMs: number;
  telemetry: RolloutTelemetry;
}

/**
 * Derive accounting from the latest cumulative wire usage. The raw NDJSON
 * remains the source of truth and is retained independently.
 */
export function summarizeDeepSweRun(outcome: RolloutOutcome): DeepSweRunSummary {
  const telemetry = deriveTelemetry(outcome.events, { repositoryRoot: "/app" });
  return {
    schemaVersion: 1,
    terminal: outcome.terminal === "killed" ? "killed" : telemetry.terminalStatus,
    timedOut: outcome.timedOut,
    ...(outcome.killedReason ? { killedReason: outcome.killedReason } : {}),
    wallClockMs: outcome.wallClockMs,
    telemetry,
  };
}

/** A crashed RPC process is infrastructure, while deliberate limit stops remain gradeable. */
export function assertGradeableDeepSweOutcome(outcome: RolloutOutcome): void {
  if (outcome.killedReason === "process_exit") {
    throw new Error("Duet RPC process exited before emitting a terminal event.");
  }
}

/** Parse an append-only RPC ledger without rejecting unknown event variants. */
export function parseKnownEvents(lines: readonly string[]): TurnEvent[] {
  return lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value &&
        typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
        ? [value as TurnEvent]
        : [];
    } catch {
      return [];
    }
  });
}
