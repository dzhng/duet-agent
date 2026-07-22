import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runCli } from "../src/cli.js";
import { runConnectCommand } from "../src/cli/connect.js";
import type { ConnectedProviderStore, ConnectionRecord } from "../src/connected-providers/store.js";

const SECRET_ACCESS = "access-must-never-appear";
const SECRET_REFRESH = "refresh-must-never-appear";

class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

function connection(): ConnectionRecord {
  return {
    provider: "openai-codex",
    credentials: {
      access: SECRET_ACCESS,
      refresh: SECRET_REFRESH,
      expires: 2_000_000_000_000,
    },
    connectedAt: 1_700_000_000_000,
    eligibility: "eligible",
    eligibilityCheckedAt: 1_700_000_001_000,
  };
}

function memoryStore(records: ConnectionRecord[]): ConnectedProviderStore {
  return {
    async read() {
      return records;
    },
    async get(id) {
      return records.find((record) => record.provider === id);
    },
    async remove(id) {
      const index = records.findIndex((record) => record.provider === id);
      if (index >= 0) records.splice(index, 1);
    },
    async withLock() {
      throw new Error("not used by connect CLI tests");
    },
  };
}

describe("duet connect", () => {
  test("--status --json prints a credential-free connections envelope", async () => {
    let stdout = "";
    await runConnectCommand(["--status", "--json"], {
      store: memoryStore([connection()]),
      write: (text) => {
        stdout += text;
      },
    });

    expect(JSON.parse(stdout)).toEqual({
      connections: [
        {
          provider: "openai-codex",
          connectedAt: 1_700_000_000_000,
          eligibility: "eligible",
          eligibilityCheckedAt: 1_700_000_001_000,
        },
      ],
    });
    expect(stdout).not.toContain("credentials");
    expect(stdout).not.toContain("access");
    expect(stdout).not.toContain("refresh");
    expect(stdout).not.toContain(SECRET_ACCESS);
    expect(stdout).not.toContain(SECRET_REFRESH);
  });

  test("bare connect prints help without reading the store", async () => {
    let helpCalls = 0;
    const store = memoryStore([]);
    store.read = async () => {
      throw new Error("bare connect must not read credentials");
    };

    await runConnectCommand([], {
      store,
      printHelp: () => {
        helpCalls++;
      },
    });

    expect(helpCalls).toBe(1);
  });

  test("--status explains how to connect when no providers are stored", async () => {
    let stdout = "";
    await runConnectCommand(["--status"], {
      store: memoryStore([]),
      write: (text) => {
        stdout += text;
      },
    });

    expect(stdout).toBe("No connected providers. Run `duet connect chatgpt`.\n");
  });

  test("empty JSON status uses the connections envelope", async () => {
    let stdout = "";
    await runConnectCommand(["--status", "--json"], {
      store: memoryStore([]),
      write: (text) => {
        stdout += text;
      },
    });

    expect(stdout).toBe('{"connections":[]}\n');
  });

  test("--disconnect exits 64 when the requested provider is not connected", async () => {
    const exit = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      let caught: unknown;
      try {
        await runConnectCommand(["--disconnect", "chatgpt"], { store: memoryStore([]) });
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBeInstanceOf(ExitCalled);
      expect((caught as ExitCalled).code).toBe(64);
      expect(String(error.mock.calls[0]?.[0])).not.toContain(SECRET_ACCESS);
      expect(String(error.mock.calls[0]?.[0])).not.toContain(SECRET_REFRESH);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  test("--disconnect removes only the selected provider and confirms without credentials", async () => {
    const records = [connection(), { ...connection(), provider: "github-copilot" as const }];
    const store = memoryStore(records);
    let stdout = "";

    await runConnectCommand(["--disconnect", "chatgpt"], {
      store,
      write: (text) => {
        stdout += text;
      },
    });

    expect(await store.read()).toEqual([{ ...connection(), provider: "github-copilot" }]);
    expect(stdout).toBe("Disconnected ChatGPT.\n");
    expect(stdout).not.toContain(SECRET_ACCESS);
    expect(stdout).not.toContain(SECRET_REFRESH);
  });

  test("human status shows provider eligibility without credential material", async () => {
    let stdout = "";
    await runConnectCommand(["--status"], {
      store: memoryStore([
        connection(),
        {
          ...connection(),
          provider: "github-copilot",
          eligibility: "plan_ineligible",
        },
      ]),
      write: (text) => {
        stdout += text;
      },
    });

    expect(stdout).toBe("ChatGPT — connected\nGitHub Copilot — plan not eligible\n");
    expect(stdout).not.toContain(SECRET_ACCESS);
    expect(stdout).not.toContain(SECRET_REFRESH);
  });

  test("unknown connect options use the usage-error exit code", async () => {
    const exit = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      let caught: unknown;
      try {
        await runConnectCommand(["--unknown"], { store: memoryStore([]) });
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBeInstanceOf(ExitCalled);
      expect((caught as ExitCalled).code).toBe(64);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  describe("top-level dispatch", () => {
    const originalArgv = process.argv;
    let logSpy: ReturnType<typeof spyOn> | undefined;

    beforeEach(() => {
      process.argv = [originalArgv[0]!, originalArgv[1]!, "connect", "--help"];
      logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      process.argv = originalArgv;
      logSpy?.mockRestore();
    });

    test("dispatches connect alongside the existing named subcommands", async () => {
      await runCli();
      expect(String(logSpy?.mock.calls[0]?.[0])).toContain("duet connect");
    });
  });
});
