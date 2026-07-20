import { describe, expect, test } from "bun:test";

import {
  ContainerHandle,
  resolveAndPullOfficialImage,
  type CommandResult,
  type CommandRunner,
} from "../src/container.js";
import type { ExecTransport } from "../src/duet-client.js";

class FakeCommands implements CommandRunner {
  readonly runs: { argv: readonly string[]; stdin?: string }[] = [];
  readonly streams: string[][] = [];
  readonly environments: NodeJS.ProcessEnv[] = [];
  results: CommandResult[] = [];

  async run(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<CommandResult> {
    if (options?.env) this.environments.push(options.env);
    this.runs.push({
      argv: [...argv],
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    return this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  stream(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): ExecTransport {
    if (options?.env) this.environments.push(options.env);
    this.streams.push([...argv]);
    return {
      stdin: { write: () => {} },
      stdoutLines: lines([]),
      kill: () => {},
      exited: Promise.resolve({ code: 0, signal: null }),
    };
  }
}

describe("SWE-bench container boundary", () => {
  test("constructs exact amd64 lifecycle, copy, exec, and RPC argv", async () => {
    const commands = new FakeCommands();
    const container = new ContainerHandle("duet-bench-1", "official/image:latest", commands);

    await container.start();
    await container.cpIn("/host/duet", "/opt/duet/duet");
    await container.exec(["/opt/duet/duet", "--version"], {
      env: { Z_KEY: "z", A_KEY: "a" },
      stdin: "input",
    });
    const transport = container.execStream(["/opt/duet/duet", "--rpc"], {
      cwd: "/testbed",
      env: { HOME: "/opt/duet/home" },
    });
    await transport.exited;
    await container.stop();

    expect(commands.runs).toEqual([
      {
        argv: [
          "docker",
          "run",
          "--platform",
          "linux/amd64",
          "--detach",
          "--name",
          "duet-bench-1",
          "--entrypoint",
          "sleep",
          "official/image:latest",
          "infinity",
        ],
      },
      { argv: ["docker", "cp", "/host/duet", "duet-bench-1:/opt/duet/duet"] },
      {
        argv: [
          "docker",
          "exec",
          "--interactive",
          "--env",
          "A_KEY",
          "--env",
          "Z_KEY",
          "duet-bench-1",
          "/opt/duet/duet",
          "--version",
        ],
        stdin: "input",
      },
      { argv: ["docker", "rm", "--force", "duet-bench-1"] },
    ]);
    expect(commands.streams).toEqual([
      [
        "docker",
        "exec",
        "--interactive",
        "--workdir",
        "/testbed",
        "--env",
        "HOME",
        "duet-bench-1",
        "/opt/duet/duet",
        "--rpc",
      ],
    ]);
  });

  test("does not issue a removal command before start or after a successful stop", async () => {
    const commands = new FakeCommands();
    const container = new ContainerHandle("duet-bench-2", "official/image:latest", commands);
    await container.stop();
    await container.start();
    await container.stop();
    await container.stop();
    expect(commands.runs.filter((call) => call.argv[1] === "rm")).toHaveLength(1);
  });

  test("forwards container environment without exposing values in Docker argv", async () => {
    const commands = new FakeCommands();
    const container = new ContainerHandle("duet-bench-env", "official/image:latest", commands);
    const credential = "not-a-real-gateway-secret";
    await container.start();

    await container.exec(["true"], { env: { AI_GATEWAY_API_KEY: credential } });
    container.execStream(["true"], { env: { AI_GATEWAY_API_KEY: credential } });

    expect(JSON.stringify([commands.runs, commands.streams])).not.toContain(credential);
    expect(commands.environments.map((env) => env.AI_GATEWAY_API_KEY)).toEqual([
      credential,
      credential,
    ]);
  });

  test("accepts only a complete official amd64 image record from the pinned helper", async () => {
    const commands = new FakeCommands();
    commands.results.push({
      stdout: JSON.stringify({
        image: "swebench/official:latest",
        platform: "linux/amd64",
        sizeBytes: 123,
        imageId: "sha256:abc",
      }),
      stderr: "",
      exitCode: 0,
    });

    await expect(
      resolveAndPullOfficialImage("org__repo-1", {
        pythonPath: "/venv/bin/python",
        helperPath: "/bench/official_image.py",
        commands,
      }),
    ).resolves.toEqual({
      image: "swebench/official:latest",
      platform: "linux/amd64",
      sizeBytes: 123,
      imageId: "sha256:abc",
    });
    expect(commands.runs[0]?.argv).toEqual([
      "/venv/bin/python",
      "/bench/official_image.py",
      "org__repo-1",
      "--pull",
      "--json",
    ]);
  });
});

async function* lines(values: readonly string[]): AsyncGenerator<string> {
  yield* values;
}
