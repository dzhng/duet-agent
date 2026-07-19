import { join } from "node:path";
import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";

// A well-behaved planner writes the spec and stops, but the soft "hand off to
// implementing" cue can tip a fraction of runs into editing kanban.tsx during
// the planning state. A single run is therefore a coin flip and can't reliably
// falsify the fix, so the eval runs the plan state ITERATIONS times and
// requires EVERY completed run to stay in scope.
const ITERATIONS = 5;
const ITERATION_TIMEOUT_MS = 180_000;
const INTERRUPT_GRACE_MS = 5_000;
const ATTEMPTS_PER_ITERATION = 2;
const RESULT_PREFIX = "SCOPE_ATTEMPT_RESULT ";
const ATTEMPT_SCRIPT = join(import.meta.dir, "helpers/state-machine-scope-attempt.ts");

interface ScopeAttemptResult {
  toolCalls: string[];
  fileEdited: boolean;
  overReached: boolean;
}

/**
 * Repro for the "planner sub-agent over-reaches and implements" failure.
 *
 * Each attempt runs in its own process group. This makes the 180-second
 * deadline real even if provider, task, or TurnRunner cancellation itself is
 * broken: the parent first sends SIGTERM so the child can interrupt the runner,
 * then SIGKILLs the whole group after a bounded cleanup window. A retry never
 * inherits tasks, connections, or timers from the timed-out runtime.
 *
 * The only-if assertion remains strict. A planner that calls write/edit or
 * changes kanban.tsx returns overReached=true; that behavioral result is never
 * retried away. Only a process timeout gets one fresh infrastructure attempt.
 */
describe("state machine agent stays in state scope", () => {
  testIfDocker(
    "a planning sub-agent plans instead of implementing across repeated runs",
    async () => {
      const overReaches: string[] = [];
      for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
        const result = await runWithOneTimeoutRetry(iteration);
        console.log(
          `--- iteration ${iteration} plan tool calls: ${JSON.stringify(result.toolCalls)} ---`,
        );
        if (result.overReached) {
          overReaches.push(
            `iteration ${iteration}: tools=${JSON.stringify(result.toolCalls)} fileEdited=${result.fileEdited}`,
          );
        }
      }
      expect(overReaches).toEqual([]);
    },
    ITERATIONS * (ITERATION_TIMEOUT_MS * ATTEMPTS_PER_ITERATION + 30_000),
  );
});

async function runWithOneTimeoutRetry(iteration: number): Promise<ScopeAttemptResult> {
  try {
    return await runAttemptProcess(iteration);
  } catch (error) {
    if (!(error instanceof ScopeIterationTimeoutError)) throw error;
    console.warn(`${error.message} Retrying once in a fresh process.`);
    return runAttemptProcess(iteration);
  }
}

async function runAttemptProcess(iteration: number): Promise<ScopeAttemptResult> {
  const proc = Bun.spawn(["setsid", "bun", ATTEMPT_SCRIPT, String(iteration)], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const completion = proc.exited.then(() => "exited" as const);
  const deadline = Bun.sleep(ITERATION_TIMEOUT_MS).then(() => "timeout" as const);

  if ((await Promise.race([completion, deadline])) === "timeout") {
    signalProcessGroup(proc.pid, "SIGTERM");
    const grace = Bun.sleep(INTERRUPT_GRACE_MS).then(() => "grace_elapsed" as const);
    if ((await Promise.race([completion, grace])) === "grace_elapsed") {
      signalProcessGroup(proc.pid, "SIGKILL");
    }
    await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    throw new ScopeIterationTimeoutError(iteration, stderr || stdout);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `Scope eval iteration ${iteration} child exited ${proc.exitCode}.\n${stderr || stdout}`,
    );
  }
  const resultLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Scope eval iteration ${iteration} emitted no result.\n${stderr || stdout}`);
  }
  return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as ScopeAttemptResult;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

class ScopeIterationTimeoutError extends Error {
  constructor(iteration: number, diagnostics = "") {
    super(
      `Scope eval iteration ${iteration} exceeded 180 seconds.${diagnostics ? `\n${diagnostics}` : ""}`,
    );
    this.name = "ScopeIterationTimeoutError";
  }
}
