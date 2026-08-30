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
const KNOWN_KEYS = new Set([
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
]);
// Line endings are byte-format state, not record metadata. Keeping them on the
// parsed object preserves CRLF without exposing a formatting field to callers.
const parsedLineEndings = new WeakMap<MemoryFileRecord, "\n" | "\r\n">();

/**
 * Identity a reader can supply for a file whose frontmatter names none — a
 * store derives it from the file itself (see `readEntry`). Each field is used
 * only when the corresponding frontmatter key is absent.
 */
export interface DerivedMemoryIdentity {
  /**
   * Record id to adopt when the header has no `id`. Must satisfy the safe
   * path-segment rule (`[A-Za-z0-9_-]+`) because ids name private archive
   * directories; the store's derivation (`mem_` + a digest) always does.
   */
  id: string;
  /**
   * Unix epoch milliseconds to adopt when the header has no `createdAt`;
   * drives newest-first ordering and the observed date, so a store passes
   * the file's own birth time.
   */
  createdAt: number;
}

/**
 * Parse a memory file's frontmatter.
 *
 * The grammar is deliberately loose on the way in and strict on the way out:
 * agents write these files by hand as often as through `duet memory add`, so
 * plain YAML scalars (`kind: note`), single or double quotes, inline arrays of
 * plain items, blank and `#` lines, and any key order are all read. `version`
 * defaults to 1 and `kind` to `note`; `id` and `createdAt` fall back to
 * `derived` when the caller can name them from the file itself. Serializing
 * always emits the one canonical form, so a rewritten file needs no leniency.
 */
export function parseMemoryFile(
  text: string,
  options: { derived?: DerivedMemoryIdentity } = {},
): MemoryFileRecord {
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
  const seenKeys = new Set<string>();
  for (const line of header.split(lineEnding)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = match[1]!.trim();
    const rawValue = (match[2] ?? "").trim();
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid frontmatter key: ${key}`);
    if (seenKeys.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
    seenKeys.add(key);
    if (key === "sourceFolder") {
      throw new Error("sourceFolder is private archive metadata and cannot enter a memory file");
    }
    if (rawValue.length === 0) continue;
    values.set(key, parseScalar(rawValue));
  }

  const version = optionalNumber(values, "version") ?? 1;
  if (version !== 1) throw new Error(`Unsupported memory file version: ${version}`);
  const kind = optionalString(values, "kind") ?? "note";
  if (kind !== "train" && kind !== "note") throw new Error(`Invalid memory kind: ${kind}`);

  const id = values.has("id") ? requireIdSegment(values, "id") : options.derived?.id;
  if (id === undefined) throw new Error("Frontmatter id is required");
  const createdAt = optionalNumber(values, "createdAt") ?? options.derived?.createdAt;
  if (createdAt === undefined) throw new Error("Frontmatter createdAt is required");
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  const fileCount = optionalNumber(values, "fileCount");
  if (fileCount !== undefined && (!Number.isSafeInteger(fileCount) || fileCount < 0)) {
    throw new Error("fileCount must be a non-negative integer");
  }

  const record: MemoryFileRecord = {
    version: 1,
    id,
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
    if (!KEY_PATTERN.test(key) || KNOWN_KEYS.has(key) || key === "sourceFolder") {
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
  const quoted = unquote(rawValue);
  if (quoted !== undefined) return quoted;
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineList(inner).map((item) => unquote(item) ?? item);
  }
  // Anything else is a plain YAML scalar: read it as the text it is.
  return rawValue;
}

function unquote(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not valid JSON: fall through to the literal text between the quotes.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return undefined;
}

/** Split `a, "b, c", 'd'` on the commas that sit outside quotes. */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    // A backslash inside double quotes escapes the next character (JSON
    // rules), so an escaped quote neither closes the string nor splits it.
    if (quote === '"' && char === "\\") {
      current += char + (inner[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (quote === undefined && (char === '"' || char === "'")) quote = char;
    else if (quote === char) quote = undefined;
    if (char === "," && quote === undefined) {
      items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current.trim());
  return items.filter((item) => item.length > 0);
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

function optionalNumber(
  values: Map<string, MemoryFrontmatterValue>,
  key: string,
): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Frontmatter ${key} must be a number`);
  return value;
}

function optionalString(
  values: Map<string, MemoryFrontmatterValue>,
  key: string,
): string | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  // A number written where text is expected reads as its text.
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") throw new Error(`Frontmatter ${key} must be a string`);
  return value;
}

function requireString(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  const value = optionalString(values, key);
  if (value === undefined) throw new Error(`Frontmatter ${key} must be a string`);
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
  const raw = values.get(key);
  if (raw === undefined) return {};
  // A single plain scalar is a one-item list.
  const value = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(value) || value.some((item) => item.trim().length === 0)) {
    throw new Error(`Frontmatter ${key} must be a string array without blank items`);
  }
  return { tags: value };
}

function extraProperties(
  values: Map<string, MemoryFrontmatterValue>,
): Partial<Pick<MemoryFileRecord, "extra">> {
  const extra = Object.fromEntries(Array.from(values).filter(([key]) => !KNOWN_KEYS.has(key)));
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
