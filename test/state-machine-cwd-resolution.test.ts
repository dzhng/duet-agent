import { afterAll, describe, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateMachineExecutionHarness } from "./helpers/state-machine-execution-harness.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "./helpers/docker-only.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import type { TurnMode } from "../src/types/protocol.js";

/**
 * A per-state `cwd` may be relative. It must resolve against the runner's
 * base cwd (config.cwd, set by `--workDir`) — the directory the `<cwd>`
 * system-prompt block advertises and the select/create validators check —
 * not the launching process's working directory. These tests pin that
 * contract across all three execution paths (script, poll, agent tools) by
 * pointing config.cwd at a temp dir that is deliberately NOT process.cwd(),
 * so a relative cwd resolved against the wrong base is observable.
 */
const tempDirs: string[] = [];

function makeWorkDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "duet-cwd-")));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createController(cwd: string): StateMachineExecutionHarness {
  return new StateMachineExecutionHarness({
    cwd,
    createStateAgent: () => {
      throw new Error("Agent state should not be invoked in cwd-resolution tests.");
    },
  });
}

class CwdProbeRunner extends TurnRunner {
  // Expose the protected tool factory so a test can read the cwd the coding
  // tools were actually bound to, mirroring how a state agent is built.
  toolsForState(cwdOverride?: string): AgentTool[] {
    return this.createTools("agent" as TurnMode, cwdOverride).tools;
  }

  // The task wrapper demands an owning scope; probes execute tools outside a
  // turn, so supply a stable root scope (TaskManager registers roots lazily).
  protected override requireRootScope(): string {
    return "cwd-probe";
  }
}

async function bashPwd(runner: CwdProbeRunner, cwdOverride: string | undefined): Promise<string> {
  const bash = runner.toolsForState(cwdOverride).find((tool) => tool.name === "bash");
  if (!bash) throw new Error("bash tool missing");
  const result = await bash.execute("call-1", { command: "pwd -P" }, undefined, () => {});
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  return text.trim();
}

describe("state cwd resolves against the runner base cwd (--workDir)", () => {
  testIfDocker("script state resolves a relative cwd against config.cwd", async () => {
    const workDir = makeWorkDir();
    const definition: StateMachineDefinition = {
      name: "script_cwd",
      prompt: "Run.",
      states: [
        { kind: "script", name: "where", command: "pwd -P", cwd: "." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController(workDir);
    controller.startSession({ prompt: "Run.", definition, currentState: "where" });

    const result = await controller.runDecision({ state: "where" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect((result.output as { stdout: string }).stdout.trim()).toBe(workDir);
    }
  });

  testIfDocker("script state resolves a relative subdirectory cwd against config.cwd", async () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, "sub"));
    const definition: StateMachineDefinition = {
      name: "script_subdir",
      prompt: "Run.",
      states: [
        { kind: "script", name: "where", command: "pwd -P", cwd: "sub" },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController(workDir);
    controller.startSession({ prompt: "Run.", definition, currentState: "where" });

    const result = await controller.runDecision({ state: "where" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect((result.output as { stdout: string }).stdout.trim()).toBe(join(workDir, "sub"));
    }
  });

  testIfDocker("poll state resolves a relative cwd against config.cwd", async () => {
    const workDir = makeWorkDir();
    const definition: StateMachineDefinition = {
      name: "poll_cwd",
      prompt: "Poll.",
      states: [
        { kind: "poll", name: "check", intervalMs: 60_000, command: "pwd -P", cwd: "." },
        { kind: "terminal", name: "done", status: "completed" },
      ],
    };
    const controller = createController(workDir);
    controller.startSession({ prompt: "Poll.", definition, currentState: "check" });

    const result = await controller.runDecision({ state: "check" });
    expect(result.type).toBe("state_completed");
    if (result.type === "state_completed") {
      expect((result.output as { stdout: string }).stdout.trim()).toBe(workDir);
    }
  });

  testIfDocker("agent coding tools resolve a relative cwd against config.cwd", async () => {
    const workDir = makeWorkDir();
    const runner = new CwdProbeRunner({ skillDiscovery: { includeDefaults: false }, cwd: workDir });
    expect(await bashPwd(runner, ".")).toBe(workDir);
  });

  testIfDocker(
    "agent coding tools resolve a relative subdirectory cwd against config.cwd",
    async () => {
      const workDir = makeWorkDir();
      mkdirSync(join(workDir, "nested"));
      const runner = new CwdProbeRunner({
        skillDiscovery: { includeDefaults: false },
        cwd: workDir,
      });
      expect(await bashPwd(runner, "nested")).toBe(join(workDir, "nested"));
    },
  );

  testIfDocker("an absolute state cwd is honored verbatim", async () => {
    const workDir = makeWorkDir();
    const otherDir = makeWorkDir();
    const runner = new CwdProbeRunner({ skillDiscovery: { includeDefaults: false }, cwd: workDir });
    expect(await bashPwd(runner, otherDir)).toBe(otherDir);
  });

  testIfDocker("no state cwd falls back to config.cwd", async () => {
    const workDir = makeWorkDir();
    const runner = new CwdProbeRunner({ skillDiscovery: { includeDefaults: false }, cwd: workDir });
    expect(await bashPwd(runner, undefined)).toBe(workDir);
  });
});
