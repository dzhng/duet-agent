import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { resolveDuetAppBaseUrl } from "../src/lib/duet-app-url.js";
import {
  fetchDefaultSkills,
  hashSkills,
  maybeAutoSyncDefaultSkills,
  syncDefaultSkills,
} from "../src/lib/sync-skills.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  delete process.env.DUET_APP_BASE_URL;
});

interface FakeRequest {
  url: string;
  headers: Record<string, string>;
}

interface FakeFetchHandler {
  (request: FakeRequest): Response | Promise<Response>;
}

function makeFetch(handler: FakeFetchHandler): {
  fetchFn: typeof fetch;
  calls: FakeRequest[];
} {
  const calls: FakeRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const entries =
        rawHeaders instanceof Headers
          ? Array.from(rawHeaders.entries())
          : Array.isArray(rawHeaders)
            ? rawHeaders
            : Object.entries(rawHeaders);
      for (const [k, v] of entries) headers[k] = String(v);
    }
    const request: FakeRequest = { url, headers };
    calls.push(request);
    return await handler(request);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function skillsResponse(
  skills: { path: string; content: string }[],
  etagOverride?: string,
): Response {
  const hash = etagOverride ?? hashSkills(skills);
  return new Response(JSON.stringify({ skills }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: `"${hash}"` },
  });
}

describe("resolveDuetAppBaseUrl", () => {
  testIfDocker("defaults to https://duet.so", () => {
    expect(resolveDuetAppBaseUrl()).toBe("https://duet.so");
  });

  testIfDocker("honors DUET_APP_BASE_URL, stripping the trailing slash", () => {
    process.env.DUET_APP_BASE_URL = "https://staging.duet.so/";
    expect(resolveDuetAppBaseUrl()).toBe("https://staging.duet.so");
  });
});

describe("hashSkills", () => {
  testIfDocker("hashes the same regardless of input order", () => {
    const a = hashSkills([
      { path: "a/SKILL.md", content: "alpha" },
      { path: "b/SKILL.md", content: "beta" },
    ]);
    const b = hashSkills([
      { path: "b/SKILL.md", content: "beta" },
      { path: "a/SKILL.md", content: "alpha" },
    ]);
    expect(a).toBe(b);
  });

  testIfDocker("changes when content changes", () => {
    const before = hashSkills([{ path: "a/SKILL.md", content: "alpha" }]);
    const after = hashSkills([{ path: "a/SKILL.md", content: "alpha-v2" }]);
    expect(before).not.toBe(after);
  });
});

describe("fetchDefaultSkills", () => {
  testIfDocker("sends If-None-Match when a known hash is provided", async () => {
    const { fetchFn, calls } = makeFetch(() => skillsResponse([]));
    await fetchDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      fetchFn,
      knownHash: "abc123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["if-none-match"] ?? calls[0]!.headers["If-None-Match"]).toBe(
      `"abc123"`,
    );
    expect(calls[0]!.headers.authorization ?? calls[0]!.headers.Authorization).toBe(
      "Bearer duet_gt_x",
    );
  });

  testIfDocker("returns not-modified on 304", async () => {
    const { fetchFn } = makeFetch(() => new Response(null, { status: 304 }));
    const result = await fetchDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      fetchFn,
      knownHash: "abc123",
    });
    expect(result).toEqual({ status: "not-modified", hash: "abc123" });
  });

  testIfDocker("rejects responses whose ETag doesn't match the body", async () => {
    const { fetchFn } = makeFetch(() =>
      skillsResponse([{ path: "a/SKILL.md", content: "alpha" }], "deadbeef"),
    );
    await expect(
      fetchDefaultSkills({ apiKey: "duet_gt_x", appBaseUrl: "https://test", fetchFn }),
    ).rejects.toThrow(/hash mismatch/i);
  });

  testIfDocker("accepts weak ETags when they contain the payload hash", async () => {
    const skills = [{ path: "a/SKILL.md", content: "alpha" }];
    const hash = hashSkills(skills);
    const { fetchFn } = makeFetch(
      () =>
        new Response(JSON.stringify({ skills }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: `W/"${hash}"` },
        }),
    );

    const result = await fetchDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      fetchFn,
    });

    expect(result).toEqual({ status: "modified", hash, skills });
  });

  testIfDocker("rejects responses missing an ETag header", async () => {
    const { fetchFn } = makeFetch(
      () =>
        new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      fetchDefaultSkills({ apiKey: "duet_gt_x", appBaseUrl: "https://test", fetchFn }),
    ).rejects.toThrow(/missing ETag/i);
  });

  testIfDocker("surfaces error bodies on non-2xx responses", async () => {
    const { fetchFn } = makeFetch(
      () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      fetchDefaultSkills({ apiKey: "duet_gt_x", appBaseUrl: "https://test", fetchFn }),
    ).rejects.toThrow(/401.*Unauthorized.*nope/);
  });
});

describe("syncDefaultSkills", () => {
  testIfDocker("writes new skills and updates the hash", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const skills = [
      { path: "alpha/SKILL.md", content: "---\nname: alpha\n---\nalpha body" },
      { path: "alpha/reference/notes.md", content: "more notes" },
    ];
    const expectedHash = hashSkills(skills);
    const { fetchFn } = makeFetch(() => skillsResponse(skills));

    const result = await syncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
    });

    if (result.status !== "synced") throw new Error("expected synced");
    expect(result.count).toBe(2);
    expect(await readFile(join(skillsDir, "alpha/SKILL.md"), "utf8")).toContain("alpha body");
    expect(await readFile(join(skillsDir, "alpha/reference/notes.md"), "utf8")).toBe("more notes");
    expect(await readFile(hashFilePath, "utf8")).toBe(expectedHash);
  });

  testIfDocker("sends If-None-Match when ~/.duet/.skills-hash exists", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");
    const knownHash = hashSkills([{ path: "a/SKILL.md", content: "alpha" }]);
    await writeFile(hashFilePath, knownHash);

    const { fetchFn, calls } = makeFetch(() => new Response(null, { status: 304 }));

    const result = await syncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
    });

    expect(result.status).toBe("unchanged");
    if (result.status === "unchanged") expect(result.hash).toBe(knownHash);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["if-none-match"] ?? calls[0]!.headers["If-None-Match"]).toBe(
      `"${knownHash}"`,
    );
    await expect(stat(skillsDir)).rejects.toThrow();
  });

  testIfDocker("omits If-None-Match when no on-disk hash exists yet", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const { fetchFn, calls } = makeFetch(() =>
      skillsResponse([{ path: "a/SKILL.md", content: "alpha" }]),
    );
    await syncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
    });

    expect(
      calls[0]!.headers["if-none-match"] ?? calls[0]!.headers["If-None-Match"],
    ).toBeUndefined();
  });

  testIfDocker("rejects skill paths that escape the skills directory", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const { fetchFn } = makeFetch(() =>
      skillsResponse([{ path: "../escape.md", content: "should not be written" }]),
    );

    await expect(
      syncDefaultSkills({
        apiKey: "duet_gt_x",
        appBaseUrl: "https://test",
        skillsDir,
        hashFilePath,
        fetchFn,
      }),
    ).rejects.toThrow(/Refusing to write skill outside/);
  });

  testIfDocker(
    "concurrent syncs converge on a complete tree with no scratch leftovers",
    async () => {
      const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
      const skillsDir = join(root, "skills");
      const hashFilePath = join(root, ".skills-hash");

      // Two `duet` processes sharing one HOME can sync concurrently. The atomic
      // swap builds each run in a per-call staging dir and renames it into place,
      // so overlapping syncs must converge: every run resolves, the surviving
      // tree is whole, and no `.staging-`/`.old-` scratch dir is orphaned. This
      // exercises the swap's concurrency safety; it is not a deterministic
      // reproduction of the pre-fix ENOENT, which needed a precise interleave.
      const skills = Array.from({ length: 30 }, (_, i) => ({
        path: `media-creation/reference/file-${i}.md`,
        content: "x".repeat(2048),
      }));
      const { fetchFn } = makeFetch(() => skillsResponse(skills));

      const runs = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          syncDefaultSkills({
            apiKey: "duet_gt_x",
            appBaseUrl: "https://test",
            skillsDir,
            hashFilePath,
            fetchFn,
          }),
        ),
      );

      for (const run of runs) {
        expect(run.status).toBe("fulfilled");
      }
      // Every skill landed intact, and the swap left no scratch dirs behind.
      expect(await readFile(join(skillsDir, "media-creation/reference/file-0.md"), "utf8")).toBe(
        "x".repeat(2048),
      );
      expect(await readFile(join(skillsDir, "media-creation/reference/file-29.md"), "utf8")).toBe(
        "x".repeat(2048),
      );
      const leftovers = (await readdir(root)).filter(
        (entry) => entry.includes(".staging-") || entry.includes(".old-"),
      );
      expect(leftovers).toEqual([]);
    },
  );
});

describe("maybeAutoSyncDefaultSkills", () => {
  function makePayload(skills: { path: string; content: string }[]) {
    return { hash: hashSkills(skills), skills };
  }

  testIfDocker("skips silently when no hash file exists", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const { fetchFn, calls } = makeFetch(() => {
      throw new Error("fetch must not run when no hash file exists");
    });

    const result = await maybeAutoSyncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  testIfDocker("skips silently when no apiKey is provided", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const hashFilePath = join(root, ".skills-hash");
    await writeFile(hashFilePath, "deadbeef");

    const { fetchFn, calls } = makeFetch(() => {
      throw new Error("fetch must not run without an API key");
    });

    const result = await maybeAutoSyncDefaultSkills({
      apiKey: "",
      appBaseUrl: "https://test",
      hashFilePath,
      fetchFn,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  testIfDocker("refreshes via If-None-Match when the hash file exists", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");
    const payload = makePayload([{ path: "a/SKILL.md", content: "alpha" }]);
    await writeFile(hashFilePath, payload.hash);

    const { fetchFn, calls } = makeFetch(() => new Response(null, { status: 304 }));

    const result = await maybeAutoSyncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
    });

    expect(result?.status).toBe("unchanged");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["if-none-match"] ?? calls[0]!.headers["If-None-Match"]).toBe(
      `"${payload.hash}"`,
    );
  });

  testIfDocker("swallows network errors and logs a warning", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const hashFilePath = join(root, ".skills-hash");
    await writeFile(hashFilePath, "deadbeef");

    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const logged: string[] = [];
    const result = await maybeAutoSyncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      hashFilePath,
      fetchFn,
      logger: (message: string) => logged.push(message),
    });

    expect(result).toBeNull();
    expect(logged.some((line) => line.includes("Skill auto-sync failed"))).toBe(true);
    expect(logged.some((line) => line.includes("network down"))).toBe(true);
  });
});
