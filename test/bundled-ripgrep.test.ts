import { describe, expect, test } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { delimiter } from "node:path";
import { withBundledRipgrep } from "../src/turn-runner/bundled-ripgrep.js";

function captureBashOps(): {
  ops: BashOperations;
  lastCall: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv };
} {
  const lastCall: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {};
  const ops: BashOperations = {
    exec: async (command, cwd, options) => {
      lastCall.command = command;
      lastCall.cwd = cwd;
      lastCall.env = options.env;
      return { exitCode: 0 };
    },
  };
  return { ops, lastCall };
}

describe("withBundledRipgrep", () => {
  test("prepends the bundled rg directory to PATH", async () => {
    const { ops, lastCall } = captureBashOps();
    const wrapped = withBundledRipgrep(ops);
    await wrapped.exec("rg --version", "/tmp", {
      onData: () => {},
      env: { PATH: "/usr/bin", FOO: "bar" },
    });

    expect(lastCall.env).toBeDefined();
    const path = lastCall.env?.PATH ?? "";
    const segments = path.split(delimiter);
    // First segment should contain the bundled rg dir.
    expect(segments[0]).toMatch(/ripgrep/);
    // Original PATH entry must still be present after the bundled dir.
    expect(segments).toContain("/usr/bin");
    // Other env vars are passed through.
    expect(lastCall.env?.FOO).toBe("bar");
  });

  test("does not duplicate the bundled rg dir on repeat calls", async () => {
    const { ops, lastCall } = captureBashOps();
    const wrapped = withBundledRipgrep(ops);
    await wrapped.exec("rg --version", "/tmp", {
      onData: () => {},
      env: { PATH: "/usr/bin" },
    });
    const firstPath = lastCall.env?.PATH ?? "";
    await wrapped.exec("rg --version", "/tmp", {
      onData: () => {},
      env: { PATH: firstPath },
    });
    const secondPath = lastCall.env?.PATH ?? "";
    expect(secondPath).toBe(firstPath);
  });

  test("does not throw when env has no PATH", async () => {
    // Sanity check: with an empty env (no PATH at all), the wrapper should
    // still forward the call without throwing. The bundled-binary-missing
    // path is exercised by resolveBundledRgPath in bundled-ripgrep.ts — it
    // returns null on platforms without a matching optional dep, and
    // withBundledRipgrep falls through to the wrapped ops unchanged.
    const { ops } = captureBashOps();
    const wrapped = withBundledRipgrep(ops);
    await expect(wrapped.exec("echo ok", "/tmp", { onData: () => {}, env: {} })).resolves.toEqual({
      exitCode: 0,
    });
  });
});
