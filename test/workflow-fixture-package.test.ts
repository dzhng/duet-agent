import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readWorkflowArchive } from "../evals/fixtures/workflow-reliability/oracle.js";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker("published archive reproduces exact fixture bytes and detects tampering", async () => {
  const build = async () => {
    const process = Bun.spawn(["bun", "scripts/build-workflow-fixtures.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited, stderr).toBe(0);
    return await readFile("dist/eval-fixtures/workflow-reliability.json", "utf8");
  };
  const first = await build();
  expect(await build()).toBe(first);
  const manifest = JSON.parse(await readFile("dist/eval-fixtures/manifest.json", "utf8"));
  expect(manifest.sha256).toBe(createHash("sha256").update(first).digest("hex"));
  const archive = readWorkflowArchive(first, manifest);
  expect(archive.files["search.ts"]).toBe(
    await readFile("evals/fixtures/workflow-reliability/app/search.ts", "utf8"),
  );
  expect(() => readWorkflowArchive(first + " ", manifest)).toThrow("SHA256 mismatch");
});

testIfDocker(
  "RPC helper drains startup events and settles a CLI with no paid prompt",
  async () => {
    const { runRpcSessionStreaming } = await import("../evals/helpers/rpc-session.js");
    let observed = false;
    const result = await runRpcSessionStreaming(
      [
        "--incognito",
        "--model",
        "duet-gateway:sonnet-5",
        "--memory-model",
        "duet-gateway:sonnet-5",
      ],
      async (rpc) => {
        await rpc.send({ type: "start", mode: "agent" });
        for await (const event of rpc.events) {
          if (event.type === "turn_started") {
            observed = true;
            break;
          }
        }
      },
      { timeoutMs: 30_000 },
    );
    expect(observed).toBe(true);
    expect(result.exitCode).toBe(0);
  },
  40_000,
);
