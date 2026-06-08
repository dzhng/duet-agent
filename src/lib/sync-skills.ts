import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveDuetAppBaseUrl } from "./duet-app-url.js";

/**
 * Mirror of the chat-app default-skill sync, kept byte-identical so the
 * server's hash and the CLI's local hash match. The chat-app endpoint
 * already renders placeholders against the caller's org; the CLI just
 * verifies the returned hash and dumps the files into ~/.duet/skills/,
 * which the turn runner reads directly.
 *
 * The hash is used as a conditional GET ETag: we send the on-disk hash via
 * `If-None-Match` and the server returns `304 Not Modified` when it still
 * matches, so a no-op `duet login` never transfers the payload at all.
 */

const DEFAULT_SKILLS_DIR = join(homedir(), ".duet", "skills");
const DEFAULT_SKILLS_HASH_FILE = join(homedir(), ".duet", ".skills-hash");

export interface RemoteSkill {
  path: string;
  content: string;
}

export type SyncSkillsResult =
  | { status: "unchanged"; hash: string }
  | { status: "synced"; hash: string; count: number };

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
}

export interface FetchSkillsOptions {
  apiKey: string;
  appBaseUrl?: string;
  fetchFn?: typeof fetch;
  /** Sent as `If-None-Match`; server returns 304 when it still matches. */
  knownHash?: string | null;
}

export type FetchSkillsResult =
  | { status: "not-modified"; hash: string }
  | { status: "modified"; hash: string; skills: RemoteSkill[] };

export async function fetchDefaultSkills(options: FetchSkillsOptions): Promise<FetchSkillsResult> {
  const baseUrl = options.appBaseUrl ?? resolveDuetAppBaseUrl();
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
  };
  if (options.knownHash) {
    headers["If-None-Match"] = `"${options.knownHash}"`;
  }
  const response = await fetchFn(`${baseUrl}/api/v1/cli/skills`, { headers });
  if (response.status === 304) {
    if (!options.knownHash) {
      throw new Error("Server returned 304 without a known hash to compare");
    }
    return { status: "not-modified", hash: options.knownHash };
  }
  if (!response.ok) {
    const detail = (await safeReadText(response)).slice(0, 256);
    throw new Error(
      `Failed to fetch default skills: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  const etag = parseSkillHashEtag(response.headers.get("ETag"));
  if (!etag) {
    throw new Error("Skills response missing ETag header");
  }
  const body = (await response.json()) as { skills: unknown };
  if (!Array.isArray(body?.skills)) {
    throw new Error("Unexpected skills response shape");
  }
  const skills = body.skills as RemoteSkill[];
  if (hashSkills(skills) !== etag) {
    throw new Error("Skill payload hash mismatch — refusing to write");
  }
  return { status: "modified", hash: etag, skills };
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

function parseSkillHashEtag(etag: string | null): string | null {
  if (!etag) return null;
  const match = etag.trim().match(/^(?:W\/)?"([^"]+)"$/);
  return match?.[1] ?? null;
}

/**
 * Best-effort startup sync. Skips silently when there is no API key, when
 * `~/.duet/.skills-hash` is absent (the user logged in without syncing), or
 * when the network call fails — startup must never block on a sync error.
 *
 * Returns the sync result on success, `null` when skipped, or `null` after a
 * caught error. Callers may inspect the return value to decide whether to
 * surface anything to the user.
 */
export async function maybeAutoSyncDefaultSkills(
  options: SyncSkillsOptions & { logger?: (message: string) => void },
): Promise<SyncSkillsResult | null> {
  if (!options.apiKey) return null;
  const hashFilePath = options.hashFilePath ?? DEFAULT_SKILLS_HASH_FILE;
  if (!(await fileExists(hashFilePath))) return null;
  const log = options.logger ?? ((message: string) => process.stderr.write(`${message}\n`));
  try {
    return await syncDefaultSkills({ ...options, hashFilePath });
  } catch (err) {
    log(`Skill auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function syncDefaultSkills(options: SyncSkillsOptions): Promise<SyncSkillsResult> {
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR;
  const hashFilePath = options.hashFilePath ?? DEFAULT_SKILLS_HASH_FILE;

  const knownHash = await readExistingHash(hashFilePath);
  const fetched = await fetchDefaultSkills({
    apiKey: options.apiKey,
    appBaseUrl: options.appBaseUrl,
    fetchFn: options.fetchFn,
    knownHash,
  });

  if (fetched.status === "not-modified") {
    return { status: "unchanged", hash: fetched.hash };
  }

  // Stage the new tree in a sibling directory and swap it into place with a
  // single rename, rather than rewriting `skillsDir` in place. A second `duet`
  // process sharing this HOME can sync or read concurrently; an in-place
  // rebuild lets it observe a half-written tree, or rm the directory out from
  // under another sync's writes (`ENOENT ... open '.../<skill>'`). With staging
  // + rename an observer only ever sees the complete old tree or the new one.
  //
  // The token is unique per call, not per process: two syncs in the same
  // process and millisecond must not share scratch dirs or they stomp each
  // other's writes.
  const swapToken = randomUUID();
  const stagingDir = `${skillsDir}.staging-${swapToken}`;
  const retiredDir = `${skillsDir}.old-${swapToken}`;

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    for (const skill of fetched.skills) {
      const target = resolve(stagingDir, skill.path);
      if (!isInsideDirectory(stagingDir, target)) {
        throw new Error(`Refusing to write skill outside ${skillsDir}: ${skill.path}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, skill.content);
    }

    await mkdir(dirname(skillsDir), { recursive: true });
    await swapIntoPlace(stagingDir, skillsDir, retiredDir);
  } finally {
    // Always clear scratch dirs: the retired tree on success, the staging tree
    // if we threw before the swap. force:true keeps this a no-op when absent.
    await rm(retiredDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }

  await mkdir(dirname(hashFilePath), { recursive: true });
  await writeFile(hashFilePath, fetched.hash);

  return { status: "synced", hash: fetched.hash, count: fetched.skills.length };
}

/**
 * Replace `skillsDir` with the freshly built `stagingDir`. rename cannot
 * overwrite a non-empty directory, so the live tree is moved aside to
 * `retiredDir` first and then the staging tree is moved into place.
 *
 * Without a cross-process lock two concurrent syncs can race on the final
 * rename: the loser finds `skillsDir` already repopulated by the winner and
 * gets EEXIST/ENOTEMPTY. Since every default-skill sync fetches the same
 * payload, the winner's tree is a complete, correct result, so a lost race is
 * success, not failure — we retry the move-aside/swap a few times and then
 * accept a peer-installed tree rather than throwing. The destructive window is
 * a single rename, so a reader at worst momentarily sees `skillsDir` absent
 * (treated as "no skills") instead of a half-written tree.
 */
async function swapIntoPlace(
  stagingDir: string,
  skillsDir: string,
  retiredDir: string,
): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Each attempt reuses retiredDir, so clear whatever a prior attempt parked
    // there before moving the live tree aside again.
    await rm(retiredDir, { recursive: true, force: true });
    try {
      await rename(skillsDir, retiredDir);
    } catch (err) {
      // ENOENT: no live tree to move aside (first sync, or a peer is mid-swap).
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await rename(stagingDir, skillsDir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A peer repopulated skillsDir between our move-aside and swap. Retry,
      // and on the final attempt accept their complete tree as the result.
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;
      if (attempt === maxAttempts - 1) return;
    }
  }
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
