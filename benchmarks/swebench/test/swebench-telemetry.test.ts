import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deriveTelemetry } from "../src/telemetry.js";
import type { TurnEvent } from "../../../src/types/protocol.js";

const FIXTURES = join(import.meta.dir, "../fixtures");

async function loadFixture(name: string): Promise<TurnEvent[]> {
  const text = await Bun.file(join(FIXTURES, name)).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

describe("SWE-bench telemetry derivation", () => {
  test("uses the terminal cumulative ledger for exact total and per-model cost", async () => {
    const telemetry = deriveTelemetry(await loadFixture("economy-rpc.sanitized.ndjson"));

    expect(telemetry.costUsdTotal).toBe(0.006905);
    expect(telemetry.costUsdByModel).toEqual({ "openai/gpt-5.6-luna": 0.006905 });
    expect(Object.values(telemetry.costUsdByModel).reduce((sum, cost) => sum + cost, 0)).toBe(
      telemetry.costUsdTotal,
    );
    expect(telemetry.tokens).toEqual({
      input: 6635,
      output: 45,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6680,
    });
    expect(telemetry.terminalStatus).toBe("completed");
  });

  test("counts Kimi and Fable advisor outcomes from generic tool details", async () => {
    const kimi = deriveTelemetry(await loadFixture("kimi-advisor.ndjson"));
    expect(kimi.advisorCalls).toEqual({
      total: 3,
      success: 1,
      rateLimited: 1,
      unavailable: 1,
      successByModel: { "moonshotai/kimi-k3": 1 },
    });

    const fable = deriveTelemetry(await loadFixture("fable-advisor.ndjson"));
    expect(fable.advisorCalls).toEqual({
      total: 1,
      success: 1,
      rateLimited: 0,
      unavailable: 0,
      successByModel: { "anthropic/claude-fable-5": 1 },
    });
  });

  test("builds switch histograms, excludes deltas and child steps, and tolerates new events", async () => {
    const events = await loadFixture("kimi-advisor.ndjson");
    events.push({ type: "future_protocol_event", payload: true } as unknown as TurnEvent);
    const telemetry = deriveTelemetry(events);

    expect(telemetry.routerSwitches).toEqual({
      "zai/glm-5.2→moonshotai/kimi-k3": 2,
      "moonshotai/kimi-k3→zai/glm-5.2": 1,
    });
    expect(telemetry.steps).toBe(4);
  });
});
