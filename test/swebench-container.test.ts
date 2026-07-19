import { describe, expect, test } from "bun:test";

import {
  ContainerHandle,
  type CommandResult,
  type CommandRunner,
} from "../benchmarks/swebench/src/container.js";
import type { ExecTransport } from "../benchmarks/swebench/src/duet-client.js";

class FakeCommands implements CommandRunner {
  readonly runs: { argv: readonly string[]; stdin?: string }[] = [];
  readonly streams: string[][] = [];
  results: CommandResult[] = [];

  async run(
    argv: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
  ): Promise<CommandResult> {
    this.runs.push({
      argv: [...argv],
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    return this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }

  stream(argv: readonly string[]): ExecTransport {
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
    const transport = container.execStream(["/opt/duet/duet", "--rpc"], { HOME: "/opt/duet/home" });
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
          "A_KEY=a",
          "--env",
          "Z_KEY=z",
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
        "--env",
        "HOME=/opt/duet/home",
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
});

async function* lines(values: readonly string[]): AsyncGenerator<string> {
  yield* values;
}
