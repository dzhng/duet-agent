import { afterEach, describe, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  beginRolloutAttempt,
  completeRolloutAttempt,
  loadRolloutAttempts,
  type RolloutArtifactSpec,
} from "../benchmarks/swebench/src/artifacts.js";
import { deriveTelemetry } from "../benchmarks/swebench/src/telemetry.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench rollout artifacts", () => {
  testIfDocker("finalizes status last and allocates immutable retry directories", async () => {
    root = await mkdtemp(join(tmpdir(), "duet-swebench-artifacts-"));
    const spec = fixtureSpec();
    const first = await beginRolloutAttempt(root, spec);
    expect(first.directory.endsWith("org__repo-1-t1")).toBe(true);
    const running = JSON.parse(await readFile(join(first.directory, "status.json"), "utf8"));
    expect(running.phase).toBe("running");

    const events = fixtureEvents();
    await completeRolloutAttempt(first, {
      events,
      patch: "diff --git a/a b/a\n",
      telemetry: deriveTelemetry(events),
      terminalType: "complete",
    });
    const second = await beginRolloutAttempt(root, spec);
    expect(second.directory.endsWith("org__repo-1-t1-a2")).toBe(true);
    await writeFile(join(root, "campaign", "campaign.json"), "{}\n");

    const loaded = await loadRolloutAttempts(root, "campaign");
    expect(loaded.map((attempt) => attempt.status.phase)).toEqual(["completed", "running"]);
    expect(await readFile(join(first.directory, "events.ndjson"), "utf8")).toContain(
      '"type":"complete"',
    );
  });
});

function fixtureSpec(): RolloutArtifactSpec {
  return {
    campaignId: "campaign",
    config: "glm-pure",
    instanceId: "org__repo-1",
    trial: 1,
    image: "official/image",
    duetSha256: "a".repeat(64),
    configSha256: "b".repeat(64),
    promptSha256: "c".repeat(64),
    limits: { costUsd: 1, wallClockMs: 1000, interruptGraceMs: 10, patchBytes: 1000 },
  };
}

function fixtureEvents(): TurnEvent[] {
  return JSON.parse(`[
    {"type":"turn_started","state":{"status":"running","mode":"agent","agent":{"status":"running","messages":[]}}},
    {"type":"complete","status":"completed","result":"done","state":{"status":"completed","mode":"agent","agent":{"status":"completed","messages":[]}},"turnUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"usageByModel":[{"model":"model","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}}}],"lastMessageUsage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0.1,"output":0.2,"cacheRead":0,"cacheWrite":0,"total":0.3}},"effectiveContextWindow":1000,"contextWindowUsage":{"systemPrompt":1,"messages":1,"localMemory":0,"globalMemory":0}}
  ]`) as TurnEvent[];
}
