import { describe, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "../../../test/helpers/docker-only.js";

describe("DeepSWE Pier job generation", () => {
  testIfDocker("forwards the available model gateway credential into every arm", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepswe-job-"));
    const output = join(root, "job.json");
    const child = Bun.spawn(
      [
        "bun",
        "benchmarks/deepswe/cli.ts",
        "job",
        "--name",
        "credential-fixture",
        "--cost-limit-usd",
        "1",
        "--output",
        output,
      ],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          DUET_API_KEY: undefined,
          OPENROUTER_API_KEY: undefined,
          AI_GATEWAY_API_KEY: "fixture-vercel-key",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);

    const job = JSON.parse(await readFile(output, "utf8")) as {
      agents: Array<{ env: Record<string, string> }>;
    };
    expect(job.agents.map((agent) => agent.env)).toEqual(
      Array.from({ length: 6 }, () => ({
        AI_GATEWAY_API_KEY: "${AI_GATEWAY_API_KEY}",
      })),
    );
  });
});
