import { spyOn } from "bun:test";
import { describe, expect } from "bun:test";

import { runUpgradeCommand } from "../src/cli/upgrade.js";
import { testIfDocker } from "./helpers/docker-only.js";

/**
 * `fail()` (used by the gate) calls `process.exit(1)` which would
 * terminate the test runner. Stub it into a thrown Error so the test
 * can assert on the surfaced message.
 */
function stubProcessExit() {
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
}

describe("runUpgradeCommand memory-in-use gate", () => {
  testIfDocker(
    "refuses to upgrade and surfaces the holder pid when another duet has the memory db open",
    async () => {
      const exitStub = stubProcessExit();
      const errorStub = spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          runUpgradeCommand(["--version", "0.1.63", "--manager", "npm"], "@duetso/agent", {
            peekMemoryHolder: () => 4242,
            memoryDbPath: "/tmp/stub-memory.db",
          }),
        ).rejects.toThrow("exit");
        const calls = errorStub.mock.calls.map((args) => args.join(" "));
        const failLine = calls.find((line) => line.startsWith("Fatal:"));
        expect(failLine).toBeDefined();
        expect(failLine).toContain("pid 4242");
        expect(failLine).toContain("/tmp/stub-memory.db");
        expect(failLine).toContain("--force");
      } finally {
        exitStub.mockRestore();
        errorStub.mockRestore();
      }
    },
  );

  testIfDocker("--force skips the gate even when a peer holds the lock", async () => {
    // `--dry-run` short-circuits before we'd actually spawn the package
    // manager, but the gate runs first. With --force the gate is bypassed
    // and we reach the dry-run print path without throwing.
    const logStub = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runUpgradeCommand(
        ["--dry-run", "--force", "--version", "0.1.63", "--manager", "npm"],
        "@duetso/agent",
        {
          peekMemoryHolder: () => 4242,
          memoryDbPath: "/tmp/stub-memory.db",
        },
      );
      const printed = logStub.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(printed).toContain("install");
      expect(printed).toContain("@duetso/agent@0.1.63");
    } finally {
      logStub.mockRestore();
    }
  });

  testIfDocker("--dry-run short-circuits before reaching the gate", async () => {
    // Dry-run prints the command and exits before any side-effectful
    // step, including the gate. Verifies dry-run remains a pure preview.
    let peekCalled = false;
    const logStub = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runUpgradeCommand(
        ["--dry-run", "--version", "0.1.63", "--manager", "npm"],
        "@duetso/agent",
        {
          peekMemoryHolder: () => {
            peekCalled = true;
            return 4242;
          },
        },
      );
      expect(peekCalled).toBe(false);
    } finally {
      logStub.mockRestore();
    }
  });
});
