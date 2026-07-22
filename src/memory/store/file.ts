import { Buffer } from "node:buffer";
import { basename } from "node:path";

/** The established Train API ceiling, applied to UTF-8 body bytes. */
export const MAX_TRAIN_RECORD_CONTENT_BYTES = 10 * 1024 * 1024;

/** A memory file's role: synthesized training or a directly curated note. */
export type MemoryKind = "train" | "note";

/** Scalar values retained for forward-compatible, unknown frontmatter keys. */
export type MemoryFrontmatterValue = string | number | string[];

/** The typed contents of one markdown memory file, excluding its filename-owned slug. */
export interface MemoryFileRecord {
  /** Byte-format version. Version 1 is the only format currently understood. */
  version: 1;
  /** Stable record identity shared with APIs and private archive metadata. */
  id: string;
  /** Whether the content came from training synthesis or direct note curation. */
  kind: MemoryKind;
  /** Unix epoch milliseconds used to derive observed dates and newest-first ordering. */
  createdAt: number;
  /** Short display label for the curated content. */
  headline?: string;
  /** Model identifier that produced synthesized content, when applicable. */
  model?: string;
  /** Number of source files represented by synthesized content. */
  fileCount?: number;
  /** Private archive manifest identifier; never an absolute archive path. */
  archiveId?: string;
  /** Ranking hint consumed by memory-context selection. */
  priority?: string;
  /** Origin label used when projecting a file into observational-memory shapes. */
  source?: string;
  /** Search and provenance labels attached to the record. */
  tags?: string[];
  /**
   * Unknown scalar keys retained byte-stably so a newer writer can add metadata
   * without an older reader silently deleting it on a content-only update.
   */
  extra?: Record<string, MemoryFrontmatterValue>;
  /** Exact curated markdown after the closing frontmatter delimiter. */
  content: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Identifiers become path segments under the private archive root, so they
// must never be able to traverse (`..`, separators) out of it. nanoid's
// alphabet plus the `mem_` prefix always satisfies this.
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const KNOWN_KEYS = [
  "version",
  "id",
  "kind",
  "createdAt",
  "headline",
  "model",
  "fileCount",
  "archiveId",
  "priority",
  "source",
  "tags",
] as const;
const KNOWN_KEY_ORDER = new Map<string, number>(KNOWN_KEYS.map((key, index) => [key, index]));
// Line endings are byte-format state, not record metadata. Keeping them on the
// parsed object preserves CRLF without exposing a formatting field to callers.
const parsedLineEndings = new WeakMap<MemoryFileRecord, "\n" | "\r\n">();

/**
 * Parse the canonical YAML-compatible subset used by memory files.
 *
 * Values are canonical JSON strings, finite decimal numbers, or inline
 * arrays of canonical JSON strings. Known keys stay in the order emitted by
 * {@link serializeMemoryFile}; unknown keys may follow them and use the same
 * scalar grammar.
 */
export function parseMemoryFile(text: string): MemoryFileRecord {
  const lineEnding = text.startsWith("---\r\n")
    ? "\r\n"
    : text.startsWith("---\n")
      ? "\n"
      : undefined;
  if (!lineEnding) throw new Error("Memory file must start with a frontmatter delimiter");

  const closingDelimiter = `${lineEnding}---${lineEnding}`;
  const closingIndex = text.indexOf(closingDelimiter, 3 + lineEnding.length);
  if (closingIndex === -1) throw new Error("Memory file is missing its closing delimiter");

  const header = text.slice(3 + lineEnding.length, closingIndex);
  const content = text.slice(closingIndex + closingDelimiter.length);
  assertContent(content);

  const values = new Map<string, MemoryFrontmatterValue>();
  let lastKnownIndex = -1;
  let sawUnknown = false;
  for (const line of header.split(lineEnding)) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator);
    const rawValue = line.slice(separator + 2);
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid frontmatter key: ${key}`);
    if (values.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
    if (key === "sourceFolder") {
      throw new Error("sourceFolder is private archive metadata and cannot enter a memory file");
    }

    const knownIndex = KNOWN_KEY_ORDER.get(key);
    if (knownIndex === undefined) {
      sawUnknown = true;
    } else {
      if (sawUnknown || knownIndex <= lastKnownIndex) {
        throw new Error(`Frontmatter key is out of canonical order: ${key}`);
      }
      lastKnownIndex = knownIndex;
    }
    values.set(key, parseScalar(rawValue));
  }

  const version = requireNumber(values, "version");
  if (version !== 1) throw new Error(`Unsupported memory file version: ${version}`);
  const kind = requireString(values, "kind");
  if (kind !== "train" && kind !== "note") throw new Error(`Invalid memory kind: ${kind}`);

  const createdAt = requireNumber(values, "createdAt");
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  const fileCount = optionalNumber(values, "fileCount");
  if (fileCount !== undefined && (!Number.isSafeInteger(fileCount) || fileCount < 0)) {
    throw new Error("fileCount must be a non-negative integer");
  }

  const record: MemoryFileRecord = {
    version: 1,
    id: requireIdSegment(values, "id"),
    kind,
    createdAt,
    ...optionalStringProperty(values, "headline"),
    ...optionalStringProperty(values, "model"),
    ...(fileCount === undefined ? {} : { fileCount }),
    ...optionalIdSegmentProperty(values, "archiveId"),
    ...optionalStringProperty(values, "priority"),
    ...optionalStringProperty(values, "source"),
    ...optionalStringArrayProperty(values, "tags"),
    ...extraProperties(values),
    content,
  };
  parsedLineEndings.set(record, lineEnding);
  return record;
}

/** Serialize a memory record into the one canonical byte representation. */
export function serializeMemoryFile(record: MemoryFileRecord): string {
  validateRecord(record);
  const lineEnding = parsedLineEndings.get(record) ?? "\n";
  const fields: Array<[string, MemoryFrontmatterValue]> = [
    ["version", record.version],
    ["id", record.id],
    ["kind", record.kind],
    ["createdAt", record.createdAt],
  ];
  appendOptional(fields, "headline", record.headline);
  appendOptional(fields, "model", record.model);
  appendOptional(fields, "fileCount", record.fileCount);
  appendOptional(fields, "archiveId", record.archiveId);
  appendOptional(fields, "priority", record.priority);
  appendOptional(fields, "source", record.source);
  appendOptional(fields, "tags", record.tags);
  for (const [key, value] of Object.entries(record.extra ?? {})) {
    if (!KEY_PATTERN.test(key) || KNOWN_KEY_ORDER.has(key) || key === "sourceFolder") {
      throw new Error(`Invalid extra frontmatter key: ${key}`);
    }
    fields.push([key, value]);
  }

  const header = fields.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join(lineEnding);
  return `---${lineEnding}${header}${lineEnding}---${lineEnding}${record.content}`;
}

/** Return the safe slug owned by a bare `<slug>.md` filename. */
export function slugFromFilename(name: string): string {
  if (basename(name) !== name || !name.endsWith(".md")) {
    throw new Error(`Memory filename must be a bare .md filename: ${name}`);
  }
  const slug = name.slice(0, -3);
  if (!SLUG_PATTERN.test(slug)) throw new Error(`Unsafe memory slug: ${slug}`);
  return slug;
}

function parseScalar(rawValue: string): MemoryFrontmatterValue {
  if (NUMBER_PATTERN.test(rawValue)) {
    const value = Number(rawValue);
    if (Number.isFinite(value) && String(value) === rawValue) return value;
  }
  try {
    const value: unknown = JSON.parse(rawValue);
    if (typeof value === "string" && JSON.stringify(value) === rawValue) return value;
    if (
      Array.isArray(value) &&
      value.every((item): item is string => typeof item === "string") &&
      `[${value.map((item) => JSON.stringify(item)).join(", ")}]` === rawValue
    ) {
      return value;
    }
  } catch {
    // The grammar error below is more useful than JSON's parser diagnostic.
  }
  throw new Error(`Unsupported frontmatter scalar: ${rawValue}`);
}

function serializeScalar(value: MemoryFrontmatterValue): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || /[eE]/.test(String(value))) {
      throw new Error(`Frontmatter numbers must be finite decimals: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  throw new Error("Frontmatter values must be strings, numbers, or string arrays");
}

function requireNumber(values: Map<string, MemoryFrontmatterValue>, key: string): number {
  const value = values.get(key);
  if (typeof value !== "number") throw new Error(`Frontmatter ${key} must be a number`);
  return value;
}

function optionalNumber(
  values: Map<string, MemoryFrontmatterValue>,
  key: string,
): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Frontmatter ${key} must be a number`);
  return value;
}

function requireString(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string") throw new Error(`Frontmatter ${key} must be a string`);
  return value;
}

function requireNonBlankString(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  const value = requireString(values, key);
  if (value.trim().length === 0) throw new Error(`Frontmatter ${key} cannot be blank`);
  return value;
}

function requireIdSegment(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  return assertIdSegment(key, requireNonBlankString(values, key));
}

function optionalIdSegmentProperty(
  values: Map<string, MemoryFrontmatterValue>,
  key: "archiveId",
): Partial<Pick<MemoryFileRecord, "archiveId">> {
  if (!values.has(key)) return {};
  return { [key]: requireIdSegment(values, key) };
}

function assertIdSegment(key: string, value: string): string {
  if (!ID_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Frontmatter ${key} must be a safe path segment: ${value}`);
  }
  return value;
}

function optionalStringProperty<K extends "headline" | "model" | "priority" | "source">(
  values: Map<string, MemoryFrontmatterValue>,
  key: K,
): Partial<Pick<MemoryFileRecord, K>> {
  if (!values.has(key)) return {};
  return { [key]: requireNonBlankString(values, key) } as Pick<MemoryFileRecord, K>;
}

function optionalStringArrayProperty(
  values: Map<string, MemoryFrontmatterValue>,
  key: "tags",
): Partial<Pick<MemoryFileRecord, "tags">> {
  const value = values.get(key);
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => item.trim().length === 0)) {
    throw new Error(`Frontmatter ${key} must be a string array without blank items`);
  }
  return { tags: value };
}

function extraProperties(
  values: Map<string, MemoryFrontmatterValue>,
): Partial<Pick<MemoryFileRecord, "extra">> {
  const extra = Object.fromEntries(Array.from(values).filter(([key]) => !KNOWN_KEY_ORDER.has(key)));
  return Object.keys(extra).length === 0 ? {} : { extra };
}

function appendOptional(
  fields: Array<[string, MemoryFrontmatterValue]>,
  key: string,
  value: MemoryFrontmatterValue | undefined,
): void {
  if (value !== undefined) fields.push([key, value]);
}

function validateRecord(record: MemoryFileRecord): void {
  if (record.version !== 1) throw new Error(`Unsupported memory file version: ${record.version}`);
  if (record.id.trim().length === 0) throw new Error("Frontmatter id cannot be blank");
  assertIdSegment("id", record.id);
  if (record.archiveId !== undefined) assertIdSegment("archiveId", record.archiveId);
  if (record.kind !== "train" && record.kind !== "note") {
    throw new Error(`Invalid memory kind: ${String(record.kind)}`);
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  if (
    record.fileCount !== undefined &&
    (!Number.isSafeInteger(record.fileCount) || record.fileCount < 0)
  ) {
    throw new Error("fileCount must be a non-negative integer");
  }
  for (const [key, value] of Object.entries({
    headline: record.headline,
    model: record.model,
    archiveId: record.archiveId,
    priority: record.priority,
    source: record.source,
  })) {
    if (value !== undefined && value.trim().length === 0) {
      throw new Error(`Frontmatter ${key} cannot be blank`);
    }
  }
  if (record.tags?.some((tag) => tag.trim().length === 0)) {
    throw new Error("Frontmatter tags cannot contain blank items");
  }
  assertContent(record.content);
}

function assertContent(content: string): void {
  if (content.trim().length === 0) throw new Error("Memory content cannot be blank");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TRAIN_RECORD_CONTENT_BYTES) {
    throw new Error(`Memory content exceeds ${MAX_TRAIN_RECORD_CONTENT_BYTES} UTF-8 bytes`);
  }
}
