import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, join } from "node:path";

import type { ArchivedFile, TrainManifest } from "./types.js";

/**
 * Hidden, per-memory archive root. Keyed by the observation id so the
 * archive and the memory row share the same lifecycle and can be cleaned
 * up together when the user prunes the memory.
 */
function archiveRootForMemoryId(memoryId: string): string {
  return join(homedir(), ".duet", "train", memoryId);
}

export interface WriteArchiveInput {
  memoryId: string;
  files: ArchivedFile[];
  manifest: TrainManifest;
}

/**
 * Copy every archived file into `<archive>/files/<relPath>` and write the
 * manifest at `<archive>/manifest.json`. Returns the archive root.
 */
export async function writeArchive(input: WriteArchiveInput): Promise<string> {
  const root = archiveRootForMemoryId(input.memoryId);
  const filesRoot = join(root, "files");
  await mkdir(filesRoot, { recursive: true });

  for (const file of input.files) {
    const destination = join(filesRoot, file.relPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.absPath, destination);
  }

  await writeFile(join(root, "manifest.json"), JSON.stringify(input.manifest, null, 2));
  return root;
}

export async function removeArchive(memoryId: string): Promise<void> {
  await rm(archiveRootForMemoryId(memoryId), { recursive: true, force: true });
}

/**
 * Skip rules for the corpus walk. We omit dotfiles/dirs, version control
 * and dependency caches, and the JSON handoff file the sub-agent uses to
 * return structured fields to the CLI.
 */
function isSkippedName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (name === "node_modules" || name === ".git") return true;
  if (name === ".duet-train.json") return true;
  return false;
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

async function walk(current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isSkippedName(entry.name)) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

/**
 * Walk the corpus folder and produce the manifest rows for the archive.
 * Purely a provenance walker — no text extraction, no MIME dispatch.
 * Results are sorted by `relPath` so the manifest is deterministic and
 * diffable across re-trains.
 */
export async function collectArchiveFiles(folder: string): Promise<ArchivedFile[]> {
  const root = path.resolve(folder);
  const absPaths: string[] = [];
  await walk(root, absPaths);

  const files: ArchivedFile[] = [];
  for (const absPath of absPaths) {
    const relPath = toPosix(path.relative(root, absPath));
    const buf = await readFile(absPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const { size: bytes } = await stat(absPath);
    files.push({ relPath, absPath, bytes, sha256 });
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}
