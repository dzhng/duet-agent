import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { resolveDuetAppBaseUrl } from "../src/lib/duet-app-url.js";
import { fetchDefaultSkills, hashSkills, syncDefaultSkills } from "../src/lib/sync-skills.js";
import { testIfDocker } from "./helpers/docker-only.js";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  delete process.env.DUET_APP_BASE_URL;
  delete process.env.DUET_GATEWAY_BASE_URL;
});

describe("resolveDuetAppBaseUrl", () => {
  testIfDocker("defaults to https://duet.so", () => {
    expect(resolveDuetAppBaseUrl()).toBe("https://duet.so");
  });

  testIfDocker("honors DUET_APP_BASE_URL exactly, stripping trailing slash", () => {
    process.env.DUET_APP_BASE_URL = "https://staging.duet.so/";
    expect(resolveDuetAppBaseUrl()).toBe("https://staging.duet.so");
  });

  testIfDocker("derives from DUET_GATEWAY_BASE_URL by stripping the gateway suffix", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://staging.duet.so/api/v1/ai-gateway";
    expect(resolveDuetAppBaseUrl()).toBe("https://staging.duet.so");
  });

  testIfDocker("falls back to default when DUET_GATEWAY_BASE_URL has no expected suffix", () => {
    process.env.DUET_GATEWAY_BASE_URL = "https://example.com/something-else";
    expect(resolveDuetAppBaseUrl()).toBe("https://duet.so");
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
  testIfDocker("rejects payloads whose hash doesn't match the body", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          hash: "deadbeef",
          skills: [{ path: "a/SKILL.md", content: "alpha" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      fetchDefaultSkills({ apiKey: "duet_gt_x", appBaseUrl: "https://test", fetchFn }),
    ).rejects.toThrow(/hash mismatch/i);
  });

  testIfDocker("surfaces error bodies on non-2xx responses", async () => {
    const fetchFn = (async () =>
      new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await expect(
      fetchDefaultSkills({ apiKey: "duet_gt_x", appBaseUrl: "https://test", fetchFn }),
    ).rejects.toThrow(/401.*Unauthorized.*nope/);
  });
});

describe("syncDefaultSkills", () => {
  async function makePayload(skills: { path: string; content: string }[]) {
    return { hash: hashSkills(skills), skills };
  }

  testIfDocker("writes new skills, updates the hash, and invokes skills add", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const payload = await makePayload([
      { path: "alpha/SKILL.md", content: "---\nname: alpha\n---\nalpha body" },
      { path: "alpha/reference/notes.md", content: "more notes" },
    ]);
    const fetchFn = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    let registeredScript: string | null = null;
    const result = await syncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn,
      runShell: async (script: string) => {
        registeredScript = script;
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result.status).toBe("synced");
    expect(result.count).toBe(2);
    expect(registeredScript).not.toBeNull();
    expect(registeredScript!).toContain(`skills add ${skillsDir}`);
    expect(registeredScript!).toContain("-g -y");
    expect(await readFile(join(skillsDir, "alpha/SKILL.md"), "utf8")).toContain("alpha body");
    expect(await readFile(join(skillsDir, "alpha/reference/notes.md"), "utf8")).toBe("more notes");
    expect(await readFile(hashFilePath, "utf8")).toBe(payload.hash);
  });

  testIfDocker("skips when the hash matches the existing on-disk hash", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const payload = await makePayload([{ path: "a/SKILL.md", content: "alpha" }]);
    await mkdir(root, { recursive: true });
    await writeFile(hashFilePath, payload.hash);

    let registered = false;
    const result = await syncDefaultSkills({
      apiKey: "duet_gt_x",
      appBaseUrl: "https://test",
      skillsDir,
      hashFilePath,
      fetchFn: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
      runShell: async () => {
        registered = true;
        return { exitCode: 0, stderr: "" };
      },
    });

    expect(result.status).toBe("unchanged");
    expect(registered).toBe(false);
    await expect(stat(skillsDir)).rejects.toThrow();
  });

  testIfDocker("does not update the hash when skills add fails", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const payload = await makePayload([{ path: "a/SKILL.md", content: "alpha" }]);
    const fetchFn = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      syncDefaultSkills({
        apiKey: "duet_gt_x",
        appBaseUrl: "https://test",
        skillsDir,
        hashFilePath,
        fetchFn,
        runShell: async () => ({ exitCode: 1, stderr: "boom" }),
      }),
    ).rejects.toThrow(/skills add.*failed/i);

    await expect(stat(hashFilePath)).rejects.toThrow();
  });

  testIfDocker("rejects skill paths that escape the skills directory", async () => {
    const root = (tempRoot = await mkdtemp(join(tmpdir(), "duet-cli-login-")));
    const skillsDir = join(root, "skills");
    const hashFilePath = join(root, ".skills-hash");

    const payload = await makePayload([{ path: "../escape.md", content: "should not be written" }]);

    await expect(
      syncDefaultSkills({
        apiKey: "duet_gt_x",
        appBaseUrl: "https://test",
        skillsDir,
        hashFilePath,
        fetchFn: (async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch,
        runShell: async () => ({ exitCode: 0, stderr: "" }),
      }),
    ).rejects.toThrow(/Refusing to write skill outside/);
  });
});
