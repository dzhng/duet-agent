import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";

import type { TurnPromptImage } from "../types/protocol.js";

/**
 * Hard cap on accepted image size. Larger images are refused outright so we
 * do not silently send oversized blobs to the model API.
 *
 * Aligned with the web composer's 20MB cap to keep CLI/web behavior consistent.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Recognized image MIME types we will accept from clipboard or file paste. */
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A single attached image plus the placeholder label rendered into the prompt. */
export interface PendingImage {
  /** Sequential id within the current input (1-based, stable across edits). */
  id: number;
  /** Inline placeholder text inserted into the input field. */
  label: string;
  /** On-disk cache path. Useful for debugging and for `/image <path>` reuse. */
  path: string;
  /** Wire payload forwarded to the runner. */
  attachment: TurnPromptImage;
}

/**
 * Sniff a few magic byte sequences to identify common web-safe image formats.
 *
 * Terminal paste events do not always carry a `mimeType`, so we fall back to
 * the bytes themselves before refusing the paste.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

/**
 * Map a file extension to one of the accepted image MIME types.
 *
 * Used as a fallback when callers paste a file path and we want to skip the
 * extra `readFile + sniff` round-trip on obvious cases. The actual bytes are
 * still validated through `sniffImageMimeType` before sending.
 */
export function mimeTypeFromExtension(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

/** Filename suffix used when persisting cached pastes. */
function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".bin";
}

/**
 * Resolve the per-session paste cache directory inside `~/.duet/cache/paste/`.
 *
 * The directory is created lazily (and only when actually used) so non-paste
 * sessions do not litter the cache root with empty subdirectories.
 */
export function pasteCacheDir(sessionId: string): string {
  return resolve(homedir(), ".duet", "cache", "paste", sessionId);
}

/**
 * Persist pasted image bytes under the session cache directory and return the
 * `PendingImage` shape the TUI tracks alongside the input buffer.
 *
 * The id and label are caller-supplied so the TUI can drive monotonic
 * `[Image #N]` numbering even when individual attachments are removed mid-edit.
 */
export async function persistPastedImage(input: {
  sessionId: string;
  id: number;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<PendingImage> {
  if (!SUPPORTED_MIME_TYPES.has(input.mimeType)) {
    throw new Error(`Unsupported image type: ${input.mimeType}`);
  }
  if (input.bytes.length === 0) {
    throw new Error("Empty image bytes");
  }
  if (input.bytes.length > MAX_IMAGE_BYTES) {
    const mb = (input.bytes.length / (1024 * 1024)).toFixed(1);
    throw new Error(`Image is too large (${mb} MB; max 20 MB)`);
  }

  const dir = pasteCacheDir(input.sessionId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `paste-${stamp}-${input.id}${extensionForMimeType(input.mimeType)}`;
  const path = resolve(dir, filename);
  await writeFile(path, input.bytes);

  // Buffer.from(Uint8Array).toString('base64') round-trips reliably across
  // both Bun and Node runtimes; pi-ai expects raw base64 (no `data:` prefix).
  const data = Buffer.from(input.bytes).toString("base64");

  return {
    id: input.id,
    label: `[Image #${input.id}]`,
    path,
    attachment: { data, mimeType: input.mimeType },
  };
}

/**
 * Load an image from disk into a `PendingImage`, verifying it is one of the
 * supported MIME types via byte sniffing.
 *
 * Used for the `/image <path>` slash command and for the auto-attach path
 * triggered when a clipboard paste turns out to be a single file path.
 */
export async function loadImageFromPath(input: {
  cwd: string;
  rawPath: string;
  id: number;
}): Promise<PendingImage> {
  const expanded = expandUserPath(input.rawPath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(input.cwd, expanded);
  if (!existsSync(absolute)) {
    throw new Error(`No file at ${absolute}`);
  }
  const bytes = new Uint8Array(await readFile(absolute));
  if (bytes.length === 0) {
    throw new Error(`File is empty: ${absolute}`);
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    throw new Error(`Image is too large (${mb} MB; max 20 MB)`);
  }
  // Sniff is authoritative — a file's extension cannot be trusted to match
  // the actual content-type header we send to the vision model.
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image type for ${absolute}`);
  }
  const data = Buffer.from(bytes).toString("base64");
  return {
    id: input.id,
    label: `[Image #${input.id}]`,
    path: absolute,
    attachment: { data, mimeType },
  };
}

/**
 * Heuristic: detect whether a chunk of pasted text is a single existing image
 * file path the user expects us to auto-attach. Many GUI environments
 * "paste the file path" when copying an image out of a file manager rather
 * than embedding the bytes themselves.
 */
export function looksLikeImageFilePath(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Single-line, plausible path length, and no whitespace inside the path
  // (matches the typical drag-and-drop / Finder path-paste shape).
  if (trimmed.includes("\n")) return undefined;
  if (trimmed.length > 4096) return undefined;
  // Strip surrounding quotes some shells/finders include.
  const unquoted = trimmed.replace(/^['"]|['"]$/g, "");
  if (unquoted.includes(" ") && !isAbsolute(unquoted)) return undefined;
  if (!mimeTypeFromExtension(unquoted)) return undefined;
  return unquoted;
}

function expandUserPath(input: string): string {
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  if (input === "~") return homedir();
  return input;
}
