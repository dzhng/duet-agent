import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

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
 * file path the user expects us to auto-attach. Real-world clipboards do
 * not deliver one canonical shape — we normalize the three we have seen in
 * the wild before matching:
 *
 *   1. raw absolute path  e.g. /Users/me/Pictures/cat.png
 *   2. shell-escaped path e.g. /Users/me/Desktop/Frame\ 2147228872.png
 *      (Ghostty/iTerm/Terminal use this when dragging a file into the prompt)
 *   3. file:// URL        e.g. file:///Users/me/Desktop/cat%20one.png
 *      (Finder copy-as-URL, browsers, some shells)
 *
 * Any surrounding whitespace or matched quotes are stripped first.
 */
export function looksLikeImageFilePath(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\n")) return undefined;
  if (trimmed.length > 4096) return undefined;

  const unquoted = stripMatchedQuotes(trimmed);
  const candidate = normalizeFilePath(unquoted);
  if (!candidate) return undefined;
  if (!mimeTypeFromExtension(candidate)) return undefined;
  return candidate;
}

/** Strip matching outer single or double quotes; leaves unquoted strings intact. */
function stripMatchedQuotes(input: string): string {
  if (input.length < 2) return input;
  const first = input[0];
  const last = input[input.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return input.slice(1, -1);
  }
  return input;
}

/**
 * Convert a clipboard-shaped path string into the absolute path on disk.
 *
 * Returns `undefined` when the input still does not resemble a single path
 * after normalization (e.g. multi-token shell input, no path separators, or
 * a string with internal whitespace that is also not absolute).
 */
function normalizeFilePath(input: string): string | undefined {
  let value = input;

  // file:// URLs need percent-decoding; the host portion (always empty for
  // local files in practice) is dropped.
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\/[^/]*/i, ""));
    } catch {
      return undefined;
    }
  }

  // Shell-escaped spaces and parens come from drag-and-drop in most macOS
  // terminals. Reverse the escaping so the result matches what the OS sees.
  if (/\\[ ()'"\\&$;]/.test(value)) {
    value = value.replace(/\\([ ()'"\\&$;])/g, "$1");
  }

  value = value.trim();
  if (!value) return undefined;

  // After unescaping, an absolute path is always acceptable. A relative
  // path with internal whitespace is too ambiguous to treat as one token —
  // could be a sentence the user intends to type — so we bail.
  if (!isAbsolute(value) && /\s/.test(value)) return undefined;
  return value;
}

/**
 * Scan a free-form string (typically the compose buffer at submit time) for
 * substrings that look like image file paths, without requiring the whole
 * string to be a single path.
 *
 * Motivation: macOS terminals do not fire a bracketed-paste event when a user
 * drags a file in — they synthesize keystrokes that type the path one
 * character at a time. The textarea sees plain typing, so `handlePasteEvent`
 * never runs and `looksLikeImageFilePath` never gets a shot. To still
 * auto-attach in that case, we scan the buffer on submit for image-shaped
 * substrings.
 *
 * Recognized shapes mirror `looksLikeImageFilePath`:
 *   • absolute paths starting with `/` or `~/`
 *   • shell-escaped paths (backslash before space/paren/quote/etc.)
 *   • `file://` URLs with percent-encoding
 *
 * Unescaped whitespace terminates a candidate, so a sentence like
 * `look at /tmp/a.png and /tmp/b.jpg` yields two candidates. Returned strings
 * are the raw matches; callers feed them through `loadImageFromPath`, which
 * unescapes and resolves them the same way the paste path does.
 */
export function extractImagePathCandidates(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  // Match either a file:// URL or an absolute/home path. The absolute-path
  // branch allows any non-newline character so that drag-pastes with mixed
  // escaping survive — macOS in particular has been observed to leave the
  // last space of a screenshot path unescaped (`Screenshot\ 2026-05-14\ at\
  // 11.05.01 PM.png`), which a stricter pattern would refuse. False-positive
  // expansion across unrelated prose is benign: `resolveExistingImagePath`
  // silently rejects candidates that do not point at a real file. The
  // negative lookbehind keeps URLs like `https://example.com/foo.png` from
  // matching their path component as if it were a local file.
  const pattern = /(?:file:\/\/\S+|(?<![\w:/])(?:\/|~\/)[^\n]+?)\.(?:png|jpe?g|gif|webp)\b/gi;
  for (const match of text.matchAll(pattern)) {
    results.push(match[0]);
  }
  return results;
}

/**
 * Resolve a raw image path (after `looksLikeImageFilePath` normalization)
 * to its absolute form on disk, or return `undefined` when no file exists
 * there. Used for silent pre-checks on the auto-attach path so that path
 * strings typed in prose (`"see /tmp/foo.png from yesterday"`) do not
 * emit a noisy `[paste]` diagnostic when the file is not actually present.
 */
export function resolveExistingImagePath(cwd: string, rawPath: string): string | undefined {
  const expanded = expandUserPath(rawPath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return existsSync(absolute) ? absolute : undefined;
}

function expandUserPath(input: string): string {
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  if (input === "~") return homedir();
  return input;
}

/**
 * Read the operating system clipboard as plain text. Used as a fallback when
 * the keystroke trigger (Cmd+V / Ctrl+V) intercepts a paste but no image is
 * present on the clipboard — we should still let the user's text paste land
 * in the prompt rather than silently swallowing it.
 *
 * Returns `undefined` when no probe succeeds or the clipboard is empty.
 */
export async function tryReadClipboardText(): Promise<string | undefined> {
  const probes = textClipboardProbesForPlatform();
  for (const probe of probes) {
    try {
      const text = await probe();
      if (text && text.length > 0) return text;
    } catch {
      // try next probe
    }
  }
  return undefined;
}

function textClipboardProbesForPlatform(): Array<() => Promise<string | undefined>> {
  const os = platform();
  if (os === "darwin") {
    return [
      async () => {
        const r = await runCommand("pbpaste", []);
        return r.code === 0 ? r.stdout : undefined;
      },
    ];
  }
  if (os === "linux") {
    return [
      async () => {
        const r = await runCommand("wl-paste", ["--no-newline"]);
        return r.code === 0 ? r.stdout : undefined;
      },
      async () => {
        const r = await runCommand("xclip", ["-selection", "clipboard", "-o"]);
        return r.code === 0 ? r.stdout : undefined;
      },
    ];
  }
  if (os === "win32") {
    return [
      async () => {
        const r = await runCommand("powershell", ["-NoProfile", "-Command", "Get-Clipboard"]);
        return r.code === 0 ? r.stdout : undefined;
      },
    ];
  }
  return [];
}

/**
 * Probe the operating system clipboard for an image and return its raw bytes.
 *
 * Most terminals do not forward binary clipboard contents on Cmd+V — even when
 * the OS pasteboard holds a real PNG (e.g. "Copy as PNG" in Figma, copying a
 * screenshot). The TUI calls this whenever a paste event fires without
 * delivering image bytes itself, so the user gets the same Claude-Code-style
 * inline attachment regardless of what the terminal stripped.
 *
 * Returns `undefined` when no image is on the clipboard or no probe succeeds.
 * Does not throw — we never want a clipboard probe to break the prompt.
 */
export async function tryReadClipboardImage(): Promise<
  { bytes: Uint8Array; mimeType: string } | undefined
> {
  const probes = clipboardProbesForPlatform();
  for (const probe of probes) {
    try {
      const bytes = await probe();
      if (bytes && bytes.length > 0) {
        const mimeType = sniffImageMimeType(bytes);
        if (mimeType && SUPPORTED_MIME_TYPES.has(mimeType)) {
          return { bytes, mimeType };
        }
      }
    } catch {
      // Try the next probe — the only known cause on macOS is that `swift`
      // is missing (Xcode CLT not installed). Linux/Windows differ by which
      // helper tool the user happens to have available.
    }
  }
  return undefined;
}

type ClipboardProbe = () => Promise<Uint8Array | undefined>;

function clipboardProbesForPlatform(): ClipboardProbe[] {
  const os = platform();
  if (os === "darwin") {
    // Swift one-liner. Runs inside a real NSApplication-backed Cocoa
    // process, which is the only env in which Chromium-based apps
    // (Figma, Slack desktop, browsers) actually fulfill their
    // NSPasteboard promise items. AppleScript class-code reads and
    // JXA via osascript both run without an NSApplication and silently
    // get nil for promise-backed UTIs.
    //
    // Swift's NSImage(pasteboard:) handles every input AppKit
    // recognizes — PNG, TIFF, JPEG, GIF, BMP, PDF, file URLs, and
    // promise items — so we do not need any further fallback probes.
    // Requires Xcode Command Line Tools (`xcode-select --install`),
    // which is a near-universal prerequisite on macOS dev machines.
    return [readMacClipboardViaSwift];
  }
  if (os === "linux") {
    return [
      // Wayland first; falls through to X11 when wl-paste is missing.
      readClipboardViaCommand("wl-paste", ["--type", "image/png"]),
      readClipboardViaCommand("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ];
  }
  if (os === "win32") {
    return [readWindowsClipboardViaPowerShell];
  }
  return [];
}

/**
 * macOS clipboard → PNG via a tiny Swift program executed in-process by
 * `swift -e`. Unlike `osascript -l JavaScript`, the swift binary launches
 * a real NSApplication-backed process, so NSPasteboard promise providers
 * (Figma, Slack desktop, browser image copies) actually deliver bytes.
 *
 * Strategy:
 *   1. NSImage(pasteboard:) — fulfills any image promise on the pasteboard.
 *   2. Re-encode via NSBitmapImageRep PNG output so we always hand back PNG.
 *
 * Returns undefined when `swift` is not installed (Xcode CLT missing) or
 * when the clipboard has no image at all. There is no fallback probe —
 * Swift covers every NSImage-representable input AppKit recognizes.
 */
async function readMacClipboardViaSwift(): Promise<Uint8Array | undefined> {
  const stamp = `${Date.now()}-${process.pid}`;
  const outPath = join(tmpdir(), `duet-swift-${stamp}.png`);
  const program = [
    "import AppKit",
    "let pb = NSPasteboard.general",
    "guard let img = NSImage(pasteboard: pb),",
    "      let tiff = img.tiffRepresentation,",
    "      let rep = NSBitmapImageRep(data: tiff),",
    `      let png = rep.representation(using: .png, properties: [:]) else { exit(2) }`,
    `try png.write(to: URL(fileURLWithPath: ${JSON.stringify(outPath)}))`,
    'print("ok")',
  ].join("\n");
  try {
    const result = await runCommand("swift", ["-e", program]);
    if (result.code !== 0) return undefined;
    if (!result.stdout.includes("ok")) return undefined;
    return new Uint8Array(await readFile(outPath));
  } catch {
    return undefined;
  } finally {
    try {
      await unlink(outPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Diagnostic: list the UTI types currently on the macOS clipboard. Surfaced
 * via the TUI when a probe round comes up empty so users can see what their
 * source app actually put on the pasteboard.
 */
export async function describeMacClipboardTypes(): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined;
  // Prefer JXA: NSPasteboard.types returns the real UTI list, including
  // `public.png`, `org.chromium.*`, and any custom UTIs the source app
  // advertised. AppleScript's `clipboard info` only surfaces the legacy
  // four-letter class codes and misses Chromium-style promise items.
  try {
    const jxa = await runCommand("osascript", [
      "-l",
      "JavaScript",
      "-e",
      "ObjC.import('AppKit'); JSON.stringify(ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.types))",
    ]);
    if (jxa.code === 0 && jxa.stdout && jxa.stdout.startsWith("[")) {
      return jxa.stdout;
    }
  } catch {
    /* fall through to AppleScript */
  }
  try {
    const result = await runCommand("osascript", [
      "-e",
      'try\nreturn (clipboard info) as text\non error e\nreturn "err:" & e\nend try',
    ]);
    if (result.code !== 0 || !result.stdout || result.stdout.startsWith("err:")) {
      return undefined;
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Generic stdout-collecting probe for tools that emit raw image bytes
 * directly (pngpaste, xclip, wl-paste). Throws on non-zero exit so the outer
 * loop falls through to the next probe.
 */
function readClipboardViaCommand(cmd: string, args: string[]): ClipboardProbe {
  return async () => {
    const result = await runCommandRaw(cmd, args);
    if (result.code !== 0 || result.stdout.length === 0) return undefined;
    return result.stdout;
  };
}

async function readWindowsClipboardViaPowerShell(): Promise<Uint8Array | undefined> {
  const tmp = join(tmpdir(), `duet-clipboard-${Date.now()}-${process.pid}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($img) {",
    `  $img.Save('${tmp.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "  Write-Output ok;",
    "} else {",
    "  Write-Output none;",
    "}",
  ].join(" ");
  try {
    const result = await runCommand("powershell", ["-NoProfile", "-Command", script]);
    if (!result.stdout.startsWith("ok")) return undefined;
    return new Uint8Array(await readFile(tmp));
  } finally {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
  }
}

async function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  const result = await runCommandRaw(cmd, args);
  return { stdout: Buffer.from(result.stdout).toString("utf8").trim(), code: result.code };
}

function runCommandRaw(cmd: string, args: string[]): Promise<{ stdout: Uint8Array; code: number }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", rejectResult);
    child.on("close", (code) => {
      const buffer = Buffer.concat(chunks);
      resolveResult({ stdout: new Uint8Array(buffer), code: code ?? 0 });
    });
  });
}
