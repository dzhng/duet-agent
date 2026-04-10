import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import type {
  Skill,
  SkillFile,
  SkillReference,
  SkillRegistry,
  SkillSource,
} from "./types.js";

/**
 * Fetch a URL with timeout. Returns the text content.
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a skill file. Supports JSON and a simple YAML-like frontmatter format.
 */
function parseSkillFile(content: string, filename: string): SkillFile {
  const trimmed = content.trim();

  // JSON
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  // Markdown with JSON frontmatter (---\n{...}\n---)
  const fmMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (fmMatch) {
    const meta = JSON.parse(fmMatch[1]);
    const body = fmMatch[2].trim();
    return {
      ...meta,
      // If the body exists and no instructions in frontmatter, use body as instructions
      instructions: meta.instructions ?? body,
    };
  }

  throw new Error(`Cannot parse skill file: ${filename}. Expected JSON or markdown with JSON frontmatter.`);
}

/**
 * Fetch and resolve reference docs from URLs.
 * Supports following links in reference docs up to maxDepth.
 */
async function resolveReferences(
  urls: string[],
  timeoutMs: number,
  maxDepth: number,
  visited: Set<string> = new Set()
): Promise<SkillReference[]> {
  const refs: SkillReference[] = [];

  for (const url of urls) {
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const content = await fetchWithTimeout(url, timeoutMs);
      const title = extractTitle(content, url);
      refs.push({ title, content, url });

      // Follow links in the reference doc if we haven't hit max depth
      if (maxDepth > 0) {
        const linkedUrls = extractLinks(content, url);
        const childRefs = await resolveReferences(
          linkedUrls,
          timeoutMs,
          maxDepth - 1,
          visited
        );
        refs.push(...childRefs);
      }
    } catch {
      // Non-fatal: skill works without the reference doc
      refs.push({
        title: url,
        content: `(Failed to fetch: ${url})`,
        url,
      });
    }
  }

  return refs;
}

/** Extract a title from content (first markdown heading or URL basename). */
function extractTitle(content: string, url: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1];
  try {
    return new URL(url).pathname.split("/").pop() ?? url;
  } catch {
    return url;
  }
}

/** Extract markdown links and raw URLs from content, resolved against a base. */
function extractLinks(content: string, baseUrl: string): string[] {
  const links: string[] = [];

  // Markdown links: [text](url)
  const mdLinks = content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
  for (const match of mdLinks) {
    links.push(match[2]);
  }

  // Only keep URLs that look like docs (not images, anchors, etc.)
  return links
    .filter((l) => !l.startsWith("#") && !l.match(/\.(png|jpg|gif|svg|ico)$/i))
    .map((l) => {
      try {
        return new URL(l, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((l): l is string => l !== null);
}

/**
 * Load a skill from a parsed SkillFile and resolve its references.
 */
async function loadSkill(
  raw: SkillFile,
  source: SkillSource,
  timeoutMs: number,
  maxRefDepth: number
): Promise<Skill> {
  const references = raw.references
    ? await resolveReferences(raw.references, timeoutMs, maxRefDepth)
    : [];

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    instructions: raw.instructions,
    tools: raw.tools ?? [],
    hasSideEffects: raw.sideEffects ?? false,
    tags: raw.tags ?? [],
    references,
    source,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover skills from a local directory. Scans for .json and .md skill files.
 */
export async function discoverLocal(
  dir: string,
  timeoutMs = 10_000,
  maxRefDepth = 1
): Promise<Skill[]> {
  const skills: Skill[] = [];
  const absDir = resolve(dir);

  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const ext = extname(entry);
    if (ext !== ".json" && ext !== ".md") continue;

    const filePath = join(absDir, entry);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;

    try {
      const content = await readFile(filePath, "utf-8");
      const raw = parseSkillFile(content, entry);
      const source: SkillSource = { kind: "local", path: filePath };
      const skill = await loadSkill(raw, source, timeoutMs, maxRefDepth);
      skills.push(skill);
    } catch {
      // Skip unparseable files
    }
  }

  return skills;
}

/**
 * Load a skill from a remote URL. The URL should point to a skill file
 * (JSON or markdown with frontmatter). Reference docs linked from the
 * skill file are fetched and resolved automatically.
 */
export async function loadRemote(
  url: string,
  timeoutMs = 10_000,
  maxRefDepth = 2
): Promise<Skill> {
  const content = await fetchWithTimeout(url, timeoutMs);
  const raw = parseSkillFile(content, url);
  const source: SkillSource = { kind: "remote", url };
  return loadSkill(raw, source, timeoutMs, maxRefDepth);
}

/**
 * Load all skills from a remote registry. A registry is a JSON endpoint
 * that returns a SkillRegistry object with a list of skill file paths.
 */
export async function loadRegistry(
  registryUrl: string,
  timeoutMs = 10_000,
  maxRefDepth = 2
): Promise<Skill[]> {
  const content = await fetchWithTimeout(registryUrl, timeoutMs);
  const registry: SkillRegistry = JSON.parse(content);

  const skills: Skill[] = [];
  const promises = registry.skills.map(async (skillPath) => {
    const skillUrl = skillPath.startsWith("http")
      ? skillPath
      : new URL(skillPath, registry.baseUrl).toString();

    try {
      const skillContent = await fetchWithTimeout(skillUrl, timeoutMs);
      const raw = parseSkillFile(skillContent, skillUrl);
      const source: SkillSource = {
        kind: "registry",
        registryUrl,
        skillId: raw.id,
      };
      return loadSkill(raw, source, timeoutMs, maxRefDepth);
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      skills.push(r.value);
    }
  }

  return skills;
}

/**
 * Discover all skills from local paths, remote URLs, and registries.
 * This is the main entry point for skill discovery.
 */
export async function discoverAll(options: {
  localPaths?: string[];
  remoteUrls?: string[];
  registryUrls?: string[];
  maxReferenceDepth?: number;
  fetchTimeoutMs?: number;
}): Promise<Skill[]> {
  const timeout = options.fetchTimeoutMs ?? 10_000;
  const maxDepth = options.maxReferenceDepth ?? 2;
  const all: Skill[] = [];

  // Run all discovery in parallel
  const [localResults, remoteResults, registryResults] = await Promise.allSettled([
    // Local
    Promise.all(
      (options.localPaths ?? []).map((p) => discoverLocal(p, timeout, maxDepth))
    ),
    // Remote
    Promise.all(
      (options.remoteUrls ?? []).map((u) => loadRemote(u, timeout, maxDepth).catch(() => null))
    ),
    // Registries
    Promise.all(
      (options.registryUrls ?? []).map((u) => loadRegistry(u, timeout, maxDepth))
    ),
  ]);

  if (localResults.status === "fulfilled") {
    for (const batch of localResults.value) all.push(...batch);
  }
  if (remoteResults.status === "fulfilled") {
    for (const skill of remoteResults.value) {
      if (skill) all.push(skill);
    }
  }
  if (registryResults.status === "fulfilled") {
    for (const batch of registryResults.value) all.push(...batch);
  }

  // Deduplicate by ID (first wins)
  const seen = new Set<string>();
  return all.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}
