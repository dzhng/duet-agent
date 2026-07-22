import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn } from "bun:test";
import {
  CONNECTED_PROVIDERS_FILE,
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectionRecord,
} from "../src/connected-providers/store.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempHome: string | undefined;

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

function record(provider: ConnectedProviderId): ConnectionRecord {
  return {
    provider,
    credentials: {
      access: `access-${provider}`,
      refresh: `refresh-${provider}`,
      expires: 2_000_000_000_000,
    },
    connectedAt: 1_700_000_000_000,
    eligibility: "eligible",
  };
}

describe("connected provider store", () => {
  testIfDocker("concurrent withLock writers preserve both provider records", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const firstStore = createConnectedProviderStore({ homeDir: tempHome });
    const secondStore = createConnectedProviderStore({ homeDir: tempHome });

    await Promise.all([
      firstStore.withLock("openai-codex", async () => {
        await Bun.sleep(30);
        return { next: record("openai-codex"), result: undefined };
      }),
      secondStore.withLock("github-copilot", async () => ({
        next: record("github-copilot"),
        result: undefined,
      })),
    ]);

    expect(await firstStore.read()).toEqual([record("openai-codex"), record("github-copilot")]);
  });

  testIfDocker("writes the credential file with mode 0600 in a 0700 directory", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const store = createConnectedProviderStore({ homeDir: tempHome });
    await store.withLock("openai-codex", async () => ({
      next: record("openai-codex"),
      result: undefined,
    }));

    const metadata = await stat(join(tempHome, ".duet", CONNECTED_PROVIDERS_FILE));
    expect(metadata.mode & 0o777).toBe(0o600);
    const directoryMetadata = await stat(join(tempHome, ".duet"));
    expect(directoryMetadata.mode & 0o777).toBe(0o700);
  });

  testIfDocker("tolerates corrupt JSON with a warning and an empty result", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const duetDir = join(tempHome, ".duet");
    await mkdir(duetDir);
    await writeFile(join(duetDir, CONNECTED_PROVIDERS_FILE), "{not-json");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createConnectedProviderStore({ homeDir: tempHome });
      expect(await store.read()).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]?.[0])).toContain("corrupt or unsupported");
    } finally {
      warning.mockRestore();
    }
  });

  testIfDocker("removes one provider without changing the other", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const store = createConnectedProviderStore({ homeDir: tempHome });
    for (const provider of ["openai-codex", "github-copilot"] as const) {
      await store.withLock(provider, async () => ({ next: record(provider), result: undefined }));
    }

    await store.remove("openai-codex");

    expect(await store.read()).toEqual([record("github-copilot")]);
  });

  testIfDocker("ignores one invalid provider record without losing its valid peer", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const duetDir = join(tempHome, ".duet");
    await mkdir(duetDir);
    await writeFile(
      join(duetDir, CONNECTED_PROVIDERS_FILE),
      JSON.stringify({
        version: 1,
        connections: {
          "openai-codex": { ...record("openai-codex"), credentials: { access: "incomplete" } },
          "github-copilot": record("github-copilot"),
        },
      }),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createConnectedProviderStore({ homeDir: tempHome });
      expect(await store.read()).toEqual([record("github-copilot")]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  testIfDocker("treats an unknown store version as empty and warns", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const duetDir = join(tempHome, ".duet");
    await mkdir(duetDir);
    await writeFile(
      join(duetDir, CONNECTED_PROVIDERS_FILE),
      JSON.stringify({ version: 2, connections: { "openai-codex": record("openai-codex") } }),
    );
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createConnectedProviderStore({ homeDir: tempHome });
      expect(await store.read()).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  testIfDocker("rejects a record for a different provider before writing", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "duet-connected-providers-"));
    const store = createConnectedProviderStore({ homeDir: tempHome });

    await expect(
      store.withLock("openai-codex", async () => ({
        next: record("github-copilot"),
        result: undefined,
      })),
    ).rejects.toThrow("must match lock provider");
    expect(await store.read()).toEqual([]);
  });
});
