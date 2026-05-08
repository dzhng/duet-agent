import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveDuetAppBaseUrl } from "./duet-app-url.js";

/**
 * Mirror of the chat-app default-skill sync, kept byte-identical so the
 * server's hash and the CLI's local hash match. The chat-app endpoint
 * already renders placeholders against the caller's org; the CLI just
 * verifies the returned hash, dumps the files into ~/.duet/skills/, and
 * registers them with the local agent harness via `skills add`.
 *
 * On any kind of registration failure we leave the on-disk hash untouched
 * so the next `duet login` (or `duet login --sync-skills-only`) retries
 * the write.
 */

const DEFAULT_SKILLS_DIR = join(homedir(), ".duet", "skills");
const DEFAULT_SKILLS_HASH_FILE = join(homedir(), ".duet", ".skills-hash");

export interface RemoteSkill {
  path: string;
  content: string;
}

export interface SkillsResponse {
  hash: string;
  skills: RemoteSkill[];
}

export interface SyncSkillsResult {
  status: "unchanged" | "synced";
  hash: string;
  count: number;
}

export interface SyncSkillsOptions {
  apiKey: string;
  /** Override the Duet app base URL; defaults to `resolveDuetAppBaseUrl()`. */
  appBaseUrl?: string;
  /** Override `~/.duet/skills` (testing). */
  skillsDir?: string;
  /** Override `~/.duet/.skills-hash` (testing). */
  hashFilePath?: string;
  /** Inject HTTP for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Skip running `skills add`; tests pass false. */
  registerSkills?: boolean;
  /** Override the registration step; tests inject a no-op. */
  runShell?: (script: string) => Promise<{ exitCode: number; stderr: string }>;
}

export async function fetchDefaultSkills(options: {
  apiKey: string;
  appBaseUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<SkillsResponse> {
  const baseUrl = options.appBaseUrl ?? resolveDuetAppBaseUrl();
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${baseUrl}/api/v1/cli/skills`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  if (!response.ok) {
    const detail = (await safeReadText(response)).slice(0, 256);
    throw new Error(
      `Failed to fetch default skills: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  const body = (await response.json()) as SkillsResponse;
  if (!body || typeof body.hash !== "string" || !Array.isArray(body.skills)) {
    throw new Error("Unexpected skills response shape");
  }

  const recomputed = hashSkills(body.skills);
  if (recomputed !== body.hash) {
    throw new Error("Skill payload hash mismatch — refusing to write");
  }
  return body;
}

export function hashSkills(skills: readonly RemoteSkill[]): string {
  const hash = createHash("sha256");
  for (const skill of [...skills].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(skill.path);
    hash.update("\0");
    hash.update(skill.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function syncDefaultSkills(options: SyncSkillsOptions): Promise<SyncSkillsResult> {
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR;
  const hashFilePath = options.hashFilePath ?? DEFAULT_SKILLS_HASH_FILE;
  const register = options.registerSkills ?? true;

  const payload = await fetchDefaultSkills({
    apiKey: options.apiKey,
    appBaseUrl: options.appBaseUrl,
    fetchFn: options.fetchFn,
  });

  const existing = await readExistingHash(hashFilePath);
  if (existing === payload.hash) {
    return { status: "unchanged", hash: payload.hash, count: payload.skills.length };
  }

  await rm(skillsDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true });

  for (const skill of payload.skills) {
    const target = resolve(skillsDir, skill.path);
    if (!isInsideDirectory(skillsDir, target)) {
      throw new Error(`Refusing to write skill outside ${skillsDir}: ${skill.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, skill.content);
  }

  if (register) {
    const runShell = options.runShell ?? defaultRunShell;
    const result = await runShell(`skills add ${shellQuote(skillsDir)} -g -y`);
    if (result.exitCode !== 0) {
      throw new Error(
        `\`skills add\` failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
      );
    }
  }

  await mkdir(dirname(hashFilePath), { recursive: true });
  await writeFile(hashFilePath, payload.hash);

  return { status: "synced", hash: payload.hash, count: payload.skills.length };
}

async function readExistingHash(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function isInsideDirectory(dir: string, candidate: string): boolean {
  const resolved = resolve(candidate);
  const normalizedDir = resolve(dir) + (dir.endsWith("/") ? "" : "/");
  return resolved === resolve(dir) || resolved.startsWith(normalizedDir);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function defaultRunShell(script: string): Promise<{ exitCode: number; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}
