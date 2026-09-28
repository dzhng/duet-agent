import { expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRpcSessionStreaming } from "../evals/helpers/rpc-session.js";
import type { TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker(
  "an eval deadline reaps the real CLI's detached shell server",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rpc-eval-reaper-"));
    let server: { pid: number; port: number } | undefined;
    try {
      await writeFile(
        join(cwd, "server.ts"),
        `
import { writeFileSync } from "node:fs";
const server = Bun.serve({ port: 0, fetch: () => new Response("still running") });
writeFileSync("server.json", JSON.stringify({ pid: process.pid, port: server.port }));
console.log("DETACHED_SERVER_READY");
`,
      );
      const definition: StateMachineDefinition = {
        name: "Sleeping server probe",
        prompt: "Wait for scheduled work.",
        states: [{ kind: "poll", name: "server", command: "exec bun server.ts", intervalMs: 1000 }],
      };
      const state: TurnState = {
        status: "sleeping",
        mode: definition,
        agent: { status: "completed", messages: [] },
        stateMachine: {
          definition,
          prompt: definition.prompt,
          currentState: "server",
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
      const trace: string[] = [];
      await expect(
        runRpcSessionStreaming(
          [
            "--incognito",
            "--workdir",
            cwd,
            "--model",
            "duet-gateway:sonnet-5",
            "--memory-model",
            "duet-gateway:sonnet-5",
          ],
          async (rpc) => {
            await rpc.send({ type: "start", state });
            await rpc.send({ type: "wake" });
            for await (const event of rpc.events) {
              trace.push(event.type === "system" ? event.message : event.type);
            }
          },
          { timeoutMs: 10_000 },
        ),
      ).rejects.toThrow("wall-clock limit exceeded");
      expect(trace).toContain("task_started");
      server = JSON.parse(await readFile(join(cwd, "server.json"), "utf8"));
      const reachable = await fetch(`http://127.0.0.1:${server!.port}`, {
        signal: AbortSignal.timeout(1000),
      }).then(
        () => true,
        () => false,
      );
      expect(reachable, "Detached server survived helper cleanup").toBe(false);
    } finally {
      server ??= await readFile(join(cwd, "server.json"), "utf8").then(JSON.parse, () => undefined);
      if (server) {
        try {
          process.kill(-server.pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
  25_000,
);
