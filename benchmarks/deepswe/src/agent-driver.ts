#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

import {
  runDuetTurn,
  type ExecTransport,
  type RolloutOutcome,
} from "../../shared/duet-rpc-client.js";
import { assertGradeableDeepSweOutcome, summarizeDeepSweRun } from "./summary.js";

const args = parseArgs(process.argv.slice(2));
const instruction = Buffer.from(args.instructionBase64, "base64").toString("utf8");
await Promise.all([
  mkdir(dirname(args.eventsPath), { recursive: true }),
  mkdir(dirname(args.stderrPath), { recursive: true }),
  mkdir(dirname(args.summaryPath), { recursive: true }),
]);

const rawEvents = createWriteStream(args.eventsPath, { flags: "a" });
const rawStderr = createWriteStream(args.stderrPath, { flags: "a" });
const transport = spawnRpc(
  [
    args.duetPath,
    "--rpc",
    "--model",
    "deepswe",
    "--session",
    "deepswe",
    "--workdir",
    "/app",
    "--system-prompt",
    "Resolve the task in the repository and leave the working tree with the complete solution. Work unattended.",
  ],
  rawEvents,
  rawStderr,
);

let outcome: RolloutOutcome | undefined;
try {
  outcome = await runDuetTurn(
    transport,
    {
      limits: {
        costUsd: args.costLimitUsd,
        wallClockMs: args.wallClockMs,
        interruptGraceMs: 90_000,
      },
    },
    instruction,
  );
} finally {
  if (!outcome) await transport.kill();
  await transport.exited;
  rawEvents.end();
  rawStderr.end();
  await Promise.all([once(rawEvents, "close"), once(rawStderr, "close")]);
}
if (!outcome) throw new Error("Duet RPC run ended without an outcome.");
assertGradeableDeepSweOutcome(outcome);
await writeFile(args.summaryPath, `${JSON.stringify(summarizeDeepSweRun(outcome), null, 2)}\n`);

interface DriverArgs {
  duetPath: string;
  instructionBase64: string;
  eventsPath: string;
  stderrPath: string;
  summaryPath: string;
  costLimitUsd: number;
  wallClockMs: number;
}

function parseArgs(argv: string[]): DriverArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Malformed agent-driver arguments near ${key ?? "<end>"}.`);
    }
    values.set(key, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const positiveNumber = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
    return value;
  };
  return {
    duetPath: required("--duet"),
    instructionBase64: required("--instruction-base64"),
    eventsPath: required("--events"),
    stderrPath: required("--stderr"),
    summaryPath: required("--summary"),
    costLimitUsd: positiveNumber("--cost-usd"),
    wallClockMs: positiveNumber("--wall-clock-ms"),
  };
}

function spawnRpc(
  argv: readonly string[],
  stdoutLog: NodeJS.WritableStream,
  stderrLog: NodeJS.WritableStream,
): ExecTransport {
  const [command, ...commandArgs] = argv;
  if (!command) throw new Error("Missing Duet executable.");
  const child = spawn(command, commandArgs, {
    cwd: "/app",
    env: {
      ...process.env,
      HOME: "/opt/duet/home",
      CI: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.pipe(stderrLog, { end: false });
  return {
    stdin: {
      write: (line) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
        }),
    },
    stdoutLines: teeLines(child.stdout, stdoutLog),
    kill: () => child.kill("SIGKILL"),
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function* teeLines(
  stream: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): AsyncGenerator<string> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!output.write(`${line}\n`)) await once(output, "drain");
      yield line;
    }
  } finally {
    lines.close();
  }
}
