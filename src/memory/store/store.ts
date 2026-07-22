import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fileSystem from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  parseMemoryFile,
  serializeMemoryFile,
  slugFromFilename,
  type MemoryFileRecord,
} from "./file.js";

/** Public view of a record read from a concrete memory-store directory. */
export interface StoredMemory {
  /** Filename stem and authoritative identity within a store. */
  slug: string;
  /** Absolute directory containing the record, used as its provenance layer. */
  storeDir: string;
  /** Stable record identity shared with APIs and private archive metadata. */
  id: string;
  /** Whether the content is synthesized training or a directly curated note. */
  kind: MemoryFileRecord["kind"];
  /** Unix epoch milliseconds used for observed dates and newest-first ordering. */
  createdAt: number;
  /** Short display label for the curated content. */
  headline?: string;
  /** Model identifier that produced synthesized content, when applicable. */
  model?: string;
  /** Number of source files represented by synthesized content. */
  fileCount?: number;
  /** Private archive manifest identifier; never an absolute archive path. */
  archiveId?: string;
  /** Exact curated markdown body. */
  content: string;
}

/** Input for a new file; the slug selects its filename and is never serialized. */
export interface MemoryEntryInput extends MemoryFileRecord {
  /** Safe filename stem used for `<slug>.md`. */
  slug: string;
}

/** List valid markdown records in lexical slug order. */
export async function listStore(dir: string): Promise<StoredMemory[]> {
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) return [];
  const directoryEntries = await fileSystem.readdir(storeDir, { withFileTypes: true });
  const memoryFilenames = directoryEntries
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Memory files cannot be symlinks: ${entry.name}`);
      if (!entry.isFile()) throw new Error(`Memory entry is not a regular file: ${entry.name}`);
      slugFromFilename(entry.name);
      return entry.name;
    })
    .sort();
  return Promise.all(memoryFilenames.map((name) => readEntry(storeDir, slugFromFilename(name))));
}

/** Read one record by its safe filename stem. */
export async function readEntry(dir: string, slug: string): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  return (await readParsedEntry(storeDir, safeSlug)).stored;
}

/** Atomically create or replace one memory file. */
export async function writeEntry(dir: string, record: MemoryEntryInput): Promise<StoredMemory> {
  const slug = assertSlug(record.slug);
  const bytes = serializeMemoryFile(record);
  const storeDir = await requireStoreDirectory(dir, true);
  if (!storeDir) throw new Error("Memory store could not be created");
  const destination = join(storeDir, `${slug}.md`);
  await rejectSymlinkIfPresent(destination);

  const temporary = join(storeDir, `.${slug}.${randomUUID()}.tmp`);
  const handle = await fileSystem.open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporary, destination);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true });
    throw error;
  }
  return toStoredMemory(storeDir, slug, record);
}

/** Replace only a record's curated body while preserving all frontmatter. */
export async function updateEntry(
  dir: string,
  slug: string,
  content: string,
): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  const { record } = await readParsedEntry(storeDir, safeSlug);
  record.content = content;
  // Keep the parsed object identity so serializeMemoryFile can retain CRLF;
  // spreading here would detach the codec's private line-ending metadata.
  return writeEntry(storeDir, Object.assign(record, { slug: safeSlug }));
}

/** Delete one record and return the bytes' parsed public view. */
export async function deleteEntry(dir: string, slug: string): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  const { stored } = await readParsedEntry(storeDir, safeSlug);
  const path = join(storeDir, `${safeSlug}.md`);
  await rejectSymlinkIfPresent(path);
  await fileSystem.unlink(path);
  return stored;
}

async function readParsedEntry(
  storeDir: string,
  slug: string,
): Promise<{ stored: StoredMemory; record: MemoryFileRecord }> {
  const path = join(storeDir, `${slug}.md`);
  const status = await fileSystem.lstat(path);
  if (status.isSymbolicLink()) throw new Error(`Memory files cannot be symlinks: ${path}`);
  if (!status.isFile()) throw new Error(`Memory entry is not a regular file: ${path}`);
  const handle = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const text = await handle.readFile("utf8").finally(() => handle.close());
  const record = parseMemoryFile(text);
  return { stored: toStoredMemory(storeDir, slug, record), record };
}

function toStoredMemory(storeDir: string, slug: string, record: MemoryFileRecord): StoredMemory {
  return {
    slug,
    storeDir,
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    ...(record.headline === undefined ? {} : { headline: record.headline }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.fileCount === undefined ? {} : { fileCount: record.fileCount }),
    ...(record.archiveId === undefined ? {} : { archiveId: record.archiveId }),
    content: record.content,
  };
}

function assertSlug(slug: string): string {
  if (basename(slug) !== slug) throw new Error(`Unsafe memory slug: ${slug}`);
  return slugFromFilename(`${slug}.md`);
}

async function requireStoreDirectory(dir: string, create: boolean): Promise<string | undefined> {
  const storeDir = resolve(dir);
  const status = await fileSystem.lstat(storeDir).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!status && create) {
    await fileSystem.mkdir(storeDir, { recursive: true, mode: 0o700 });
    const createdStatus = await fileSystem.lstat(storeDir);
    if (!createdStatus.isDirectory() || createdStatus.isSymbolicLink()) {
      throw new Error(`Memory store must be a real directory: ${storeDir}`);
    }
    return storeDir;
  }
  if (!status) return undefined;
  if (status.isSymbolicLink()) throw new Error(`Memory stores cannot be symlinks: ${storeDir}`);
  if (!status.isDirectory()) throw new Error(`Memory store is not a directory: ${storeDir}`);
  return storeDir;
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  const status = await fileSystem.lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (status?.isSymbolicLink()) throw new Error(`Memory files cannot be symlinks: ${path}`);
  if (status && !status.isFile()) throw new Error(`Memory entry is not a regular file: ${path}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
