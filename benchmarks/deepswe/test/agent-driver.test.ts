import { describe, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";

describe("DeepSWE in-container driver", () => {
  testIfDocker("preserves raw wire lines and derives final cumulative usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-driver-"));
    const fakeDuet = join(root, "fake-duet");
    const events = join(root, "events.ndjson");
    const stderr = join(root, "stderr.log");
    const summary = join(root, "summary.json");
    await mkdir("/app", { recursive: true });
    await writeFile(
      fakeDuet,
      [
        "#!/bin/sh",
        "read start",
        "read prompt",
        "echo 'banner' >&2",
        `echo '{"type":"future_protocol_event","kept":true}'`,
        `echo '{"type":"complete","status":"completed","turnUsage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":0,"totalTokens":15,"cost":{"input":1,"output":0.5,"cacheRead":0.1,"cacheWrite":0,"total":1.6}},"usageByModel":[{"model":"executor","usage":{"input":10,"output":2,"cacheRead":3,"cacheWrite":0,"totalTokens":15,"cost":{"input":1,"output":0.5,"cacheRead":0.1,"cacheWrite":0,"total":1.6}}}]}'`,
        "",
      ].join("\n"),
    );
    await chmod(fakeDuet, 0o755);
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../src/agent-driver.ts"),
        "--duet",
        fakeDuet,
        "--instruction-base64",
        Buffer.from("fix it").toString("base64"),
        "--events",
        events,
        "--stderr",
        stderr,
        "--summary",
        summary,
        "--cost-usd",
        "10",
        "--wall-clock-ms",
        "10000",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, processStderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, processStderr).toBe(0);
    expect(await readFile(events, "utf8")).toContain(
      '{"type":"future_protocol_event","kept":true}',
    );
    expect(await readFile(stderr, "utf8")).toContain("banner");
    expect(JSON.parse(await readFile(summary, "utf8"))).toMatchObject({
      terminal: "completed",
      telemetry: {
        costUsdTotal: 1.6,
        usageByModel: [{ model: "executor" }],
      },
    });
  });
});
