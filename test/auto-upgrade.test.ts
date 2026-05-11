import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect } from "bun:test";

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  __testing,
  PACKAGE_MANAGER_SPAWN_OPTIONS,
  createUpgradeStatusStream,
  defaultRunUpgrade,
  describeUpgradeStatus,
  isLikelyGlobalInstall,
  NO_AUTO_UPGRADE_ENV,
  runAutoUpgrade,
  type UpgradeStatus,
} from "../src/cli/auto-upgrade.js";
import { testIfDocker } from "./helpers/docker-only.js";

const ORIGINAL_HOME = process.env.HOME;
let scratchHome: string | undefined;

const GLOBAL_PATH = "/lib/node_modules/@duetso/agent/dist/src/cli.js";

beforeEach(() => {
  // Each test gets its own fake $HOME so .duet/upgrade.lock writes never leak.
  scratchHome = mkdtempSync(join(tmpdir(), "duet-auto-upgrade-"));
  process.env.HOME = scratchHome;
});

afterEach(() => {
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe("isLikelyGlobalInstall", () => {
  testIfDocker("accepts npm global lib path", () => {
    expect(
      isLikelyGlobalInstall(
        "/Users/x/.nvm/versions/node/v22/lib/node_modules/@duetso/agent/dist/src/cli.js",
      ),
    ).toBe(true);
  });
  testIfDocker("accepts bun global path", () => {
    expect(
      isLikelyGlobalInstall(
        "/Users/x/.bun/install/global/node_modules/@duetso/agent/dist/src/cli.js",
      ),
    ).toBe(true);
  });
  testIfDocker("rejects source checkout", () => {
    expect(isLikelyGlobalInstall("/Users/x/dev/duet-agent/src/cli.ts")).toBe(false);
  });
});

describe("describeUpgradeStatus", () => {
  testIfDocker("renders user-facing copy for each visible state", () => {
    expect(describeUpgradeStatus("@duetso/agent", { kind: "checking" })).toBe(
      "Checking for updates…",
    );
    expect(
      describeUpgradeStatus("@duetso/agent", {
        kind: "upgrading",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
      }),
    ).toBe("Updating @duetso/agent 0.1.62 → 0.1.63…");
    expect(
      describeUpgradeStatus("@duetso/agent", {
        kind: "upgraded",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
      }),
    ).toBe("Updated @duetso/agent to 0.1.63. Restart duet to use it.");
    expect(
      describeUpgradeStatus("@duetso/agent", {
        kind: "failed",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
        error: "EACCES",
      }),
    ).toBe("Update to 0.1.63 failed (EACCES). Run: duet upgrade");
  });

  testIfDocker("hides current/locked/skipped from the header", () => {
    expect(
      describeUpgradeStatus("@duetso/agent", { kind: "current", version: "0.1.62" }),
    ).toBeUndefined();
    expect(describeUpgradeStatus("@duetso/agent", { kind: "locked" })).toBeUndefined();
    expect(
      describeUpgradeStatus("@duetso/agent", { kind: "skipped", reason: "disabled" }),
    ).toBeUndefined();
  });
});

describe("runAutoUpgrade", () => {
  testIfDocker("emits checking → current when already on latest", async () => {
    const statuses: UpgradeStatus[] = [];
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
      fetchLatest: async () => "0.1.62",
      runUpgrade: async () => ({ ok: true }),
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses.map((s) => s.kind)).toEqual(["checking", "current"]);
    expect(final.kind).toBe("current");
  });

  testIfDocker("emits checking → upgrading → upgraded when a newer version exists", async () => {
    const statuses: UpgradeStatus[] = [];
    const calls: string[][] = [];
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
      detectManager: () => "npm",
      fetchLatest: async () => "0.1.63",
      runUpgrade: async (command) => {
        calls.push(command);
        return { ok: true };
      },
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses.map((s) => s.kind)).toEqual(["checking", "upgrading", "upgraded"]);
    expect(calls).toEqual([["npm", "install", "--global", "@duetso/agent@0.1.63"]]);
    expect(final.kind).toBe("upgraded");
    const log = readFileSync(join(homedir(), ".duet", "logs", "upgrade.log"), "utf8");
    expect(log).toContain("upgraded package=@duetso/agent from=0.1.62 to=0.1.63 manager=npm");
  });

  testIfDocker(
    "emits failed and surfaces stderr when the package manager exits non-zero",
    async () => {
      const statuses: UpgradeStatus[] = [];
      const final = await runAutoUpgrade({
        packageName: "@duetso/agent",
        currentVersion: "0.1.62",
        scriptPath: GLOBAL_PATH,
        env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
        detectManager: () => "npm",
        fetchLatest: async () => "0.1.63",
        runUpgrade: async () => ({ ok: false, stderr: "EACCES" }),
        onStatus: (status) => statuses.push(status),
      });
      expect(statuses.at(-1)).toEqual({
        kind: "failed",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
        error: "EACCES",
      });
      expect(final.kind).toBe("failed");
    },
  );

  testIfDocker("emits locked when another worker holds a fresh lock", async () => {
    const { lockPath, duetDir } = __testing.upgradePaths();
    mkdirSync(duetDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1_000 }));
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
      fetchLatest: async () => {
        throw new Error("should not be called when locked");
      },
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final.kind).toBe("locked");
    expect(existsSync(lockPath)).toBe(true);
  });

  testIfDocker("reclaims a stale lock and proceeds", async () => {
    const { lockPath, duetDir } = __testing.upgradePaths();
    mkdirSync(duetDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: Date.now() - (__testing.STALE_LOCK_MS + 1_000) }),
    );
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
      fetchLatest: async () => "0.1.62",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final.kind).toBe("current");
    expect(existsSync(lockPath)).toBe(false);
  });

  testIfDocker("returns skipped when DUET_NO_AUTO_UPGRADE=1", async () => {
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: "1" },
      fetchLatest: async () => "0.1.63",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final).toEqual({ kind: "skipped", reason: "disabled" });
  });

  testIfDocker("returns skipped when invoked from a source checkout", async () => {
    const final = await runAutoUpgrade({
      packageName: "@duetso/agent",
      currentVersion: "0.1.62",
      scriptPath: "/Users/x/dev/duet-agent/src/cli.ts",
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined },
      fetchLatest: async () => "0.1.63",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final).toEqual({ kind: "skipped", reason: "source-checkout" });
  });
});

interface FakeChild extends EventEmitter {
  stderr: Readable & { unref(): void };
  unref(): void;
}

function buildFakeChild(
  trackUnref: { child: () => void; stderr: () => void } = { child: () => {}, stderr: () => {} },
): FakeChild {
  const stderr = Object.assign(new Readable({ read() {} }), { unref: trackUnref.stderr });
  return Object.assign(new EventEmitter(), { stderr, unref: trackUnref.child }) as FakeChild;
}

describe("defaultRunUpgrade spawn contract", () => {
  testIfDocker(
    "spawns the package manager detached and unrefs the child so the parent can exit",
    async () => {
      let capturedOptions: SpawnOptions | undefined;
      let unrefCalls = 0;
      let stderrUnrefCalls = 0;

      const fakeSpawn = (
        _command: string,
        _args: string[],
        options: SpawnOptions,
      ): ChildProcess => {
        capturedOptions = options;
        const child = buildFakeChild({
          child: () => {
            unrefCalls += 1;
          },
          stderr: () => {
            stderrUnrefCalls += 1;
          },
        });
        // Resolve immediately so the test does not hang.
        queueMicrotask(() => {
          child.stderr.push(null);
          child.emit("exit", 0);
        });
        return child as unknown as ChildProcess;
      };

      const result = await defaultRunUpgrade(
        ["npm", "install", "--global", "@duetso/agent@0.1.63"],
        fakeSpawn,
      );
      expect(result).toEqual({ ok: true });
      expect(capturedOptions?.detached).toBe(true);
      // stdio must keep stderr pipe so we can capture install errors, while
      // stdin/stdout are dropped so the install does not bid for the TTY.
      expect(capturedOptions?.stdio).toEqual(["ignore", "ignore", "pipe"]);
      expect(unrefCalls).toBe(1);
      expect(stderrUnrefCalls).toBe(1);
    },
  );

  testIfDocker("surfaces stderr from a failed install", async () => {
    const fakeSpawn = (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
      const child = buildFakeChild();
      queueMicrotask(() => {
        child.stderr.push("npm ERR! permission denied\n");
        child.stderr.push(null);
        child.emit("exit", 1);
      });
      return child as unknown as ChildProcess;
    };

    const result = await defaultRunUpgrade(["npm", "install", "--global", "x"], fakeSpawn);
    expect(result).toEqual({ ok: false, stderr: "npm ERR! permission denied" });
  });

  testIfDocker(
    "PACKAGE_MANAGER_SPAWN_OPTIONS is the single source of truth for the spawn contract",
    () => {
      expect(PACKAGE_MANAGER_SPAWN_OPTIONS.detached).toBe(true);
      expect(PACKAGE_MANAGER_SPAWN_OPTIONS.stdio).toEqual(["ignore", "ignore", "pipe"]);
    },
  );
});

describe("createUpgradeStatusStream", () => {
  testIfDocker("replays the latest status to late subscribers", () => {
    const stream = createUpgradeStatusStream();
    stream.publish({ kind: "checking" });
    stream.publish({ kind: "upgrading", from: "0.1.62", to: "0.1.63", manager: "npm" });

    const seen: UpgradeStatus[] = [];
    stream.subscribe((status) => seen.push(status));
    expect(seen).toEqual([{ kind: "upgrading", from: "0.1.62", to: "0.1.63", manager: "npm" }]);
  });

  testIfDocker("publish() fans out to every active subscriber and skips after unsubscribe", () => {
    const stream = createUpgradeStatusStream();
    const a: UpgradeStatus[] = [];
    const b: UpgradeStatus[] = [];
    const unsubscribeA = stream.subscribe((status) => a.push(status));
    stream.subscribe((status) => b.push(status));

    stream.publish({ kind: "checking" });
    unsubscribeA();
    stream.complete({ kind: "current", version: "0.1.62" });

    expect(a).toEqual([{ kind: "checking" }]);
    expect(b).toEqual([{ kind: "checking" }, { kind: "current", version: "0.1.62" }]);
  });

  testIfDocker("complete() does not re-emit when the final status was already published", () => {
    const stream = createUpgradeStatusStream();
    const seen: UpgradeStatus[] = [];
    stream.subscribe((status) => seen.push(status));

    const upgraded: UpgradeStatus = {
      kind: "upgraded",
      from: "0.1.62",
      to: "0.1.63",
      manager: "npm",
    };
    stream.publish(upgraded);
    stream.complete(upgraded);

    expect(seen).toEqual([upgraded]);
  });
});
