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
      // Try the next probe — platform tools commonly differ in availability
      // (e.g. pngpaste only present when a user installed it via Homebrew).
    }
  }
  return undefined;
}

type ClipboardProbe = () => Promise<Uint8Array | undefined>;

function clipboardProbesForPlatform(): ClipboardProbe[] {
  const os = platform();
  if (os === "darwin") {
    return [
      // First: native Swift one-liner. Runs inside a real Cocoa process
      // (NSApplication context, real run loop), which is the only env in
      // which Chromium-based apps (Figma, Slack desktop, browsers) will
      // actually fulfill their NSPasteboard promise items. JXA via
      // osascript and AppleScript class-code reads both run without an
      // NSApplication and silently get nil for promise-backed UTIs.
      // Requires Xcode Command Line Tools (`xcode-select --install`),
      // which is a near-universal prerequisite on dev machines.
      readMacClipboardViaSwift,
      // Second: NSPasteboard via the ObjC bridge (JXA). Catches non-promise
      // clipboards Swift may have skipped, and works on machines without
      // Xcode CLT.
      readMacClipboardViaJxa,
      // Cheap path when installed: pngpaste handles every NSImage
      // representation natively.
      readClipboardViaCommand("pngpaste", ["-"]),
      // Last-resort AppleScript class probes for older clipboards that JXA
      // still cannot read. Convert non-PNG flavors via macOS's built-in
      // `sips` so the rest of the pipeline only sees one of the four MIME
      // types we accept.
      readMacClipboardClass("PNGf", ".png", null),
      readMacClipboardClass("TIFF", ".tiff", "png"),
      readMacClipboardClass("JPEG", ".jpg", "png"),
      readMacClipboardClass("PDF ", ".pdf", "png"),
    ];
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
 * macOS clipboard → PNG via JavaScript for Automation (JXA) and the ObjC
 * bridge to NSPasteboard. JXA ships with every macOS install since 10.10,
 * so we get a real Cocoa-level pasteboard reader at no install cost.
 *
 * Works for clipboards that AppleScript class-code reads cannot see, in
 * particular the NSPasteboard "promise items" that Chromium-based apps
 * (Figma, Slack desktop, web browsers) use to defer image generation.
 *
 * Tries supported public UTIs in order: PNG → JPEG → TIFF → GIF → BMP → PDF.
 * Non-PNG payloads are written to a temp file and transcoded to PNG via
 * `sips` so the rest of the pipeline only ever sees one of the four MIME
 * types we accept.
 */
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
 * when the clipboard has no image at all. The caller then falls through
 * to the JXA / AppleScript probes.
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

async function readMacClipboardViaJxa(): Promise<Uint8Array | undefined> {
  const stamp = `${Date.now()}-${process.pid}`;
  const rawPath = join(tmpdir(), `duet-jxa-${stamp}.bin`);
  const pngPath = join(tmpdir(), `duet-jxa-${stamp}.png`);
  // Layered probe: try every method we know AppKit exposes for clipboard
  // image extraction, in order from "definitely materializes promise items"
  // to "raw byte read." Chromium-based apps (Figma, Slack, browsers) put
  // images on the pasteboard as promise items, so -dataForType: returns nil
  // until the promise is resolved by NSImage.
  //
  // Methods tried (first hit wins):
  //   1. NSImage initWithPasteboard:        — most aggressive promise resolver
  //   2. readObjectsForClasses:[NSImage]    — modern API, also resolves promises
  //   3. pasteboardItems iteration          — per-item dataForType reads
  //   4. legacy direct dataForType reads    — non-promise clipboards, PDF, etc.
  //
  // We use raw integer 4 for NSPNGFileType because the JXA bridge does not
  // reliably surface the NSBitmapImageFileTypePNG enum constant.
  const script = `
    ObjC.import('AppKit');
    ObjC.import('Foundation');
    const pb = $.NSPasteboard.generalPasteboard;
    const rawPath = $(${JSON.stringify(rawPath)});
    const NSPNGFileType = 4;

    function writeImageAsPng(img) {
      if (!img || img.isNil()) return false;
      const tiff = img.TIFFRepresentation;
      if (!tiff || tiff.isNil() || tiff.length === 0) return false;
      const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (!rep || rep.isNil()) return false;
      const png = rep.representationUsingTypeProperties(NSPNGFileType, $());
      if (!png || png.isNil() || png.length === 0) return false;
      return png.writeToFileAtomically(rawPath, true);
    }

    function emit(kind, method) {
      console.log(JSON.stringify({ ok: true, kind, method }));
    }

    let done = false;

    // Method 1: NSImage initWithPasteboard — most aggressive promise resolver.
    try {
      const img = $.NSImage.alloc.initWithPasteboard(pb);
      if (writeImageAsPng(img)) { emit('png', 'initWithPasteboard'); done = true; }
    } catch (e) { console.log(JSON.stringify({ ok: false, method: 'initWithPasteboard', err: String(e) })); }

    // Method 2: readObjectsForClasses with NSImage.
    if (!done) {
      try {
        const classes = $.NSArray.arrayWithObject($.NSImage);
        const objs = pb.readObjectsForClassesOptions(classes, $());
        if (objs && !objs.isNil() && objs.count > 0) {
          if (writeImageAsPng(objs.objectAtIndex(0))) { emit('png', 'readObjectsForClasses'); done = true; }
        }
      } catch (e) { console.log(JSON.stringify({ ok: false, method: 'readObjectsForClasses', err: String(e) })); }
    }

    // Method 3: iterate pasteboardItems and try image UTIs on each item.
    if (!done) {
      try {
        const items = pb.pasteboardItems;
        if (items && !items.isNil()) {
          const flavors = [['public.png','png'],['public.jpeg','jpeg'],['public.tiff','tiff'],['com.compuserve.gif','gif'],['com.microsoft.bmp','bmp'],['com.adobe.pdf','pdf']];
          for (let i = 0; i < items.count && !done; i++) {
            const item = items.objectAtIndex(i);
            for (const [uti, kind] of flavors) {
              const data = item.dataForType(uti);
              if (data && !data.isNil() && data.length > 0) {
                if (data.writeToFileAtomically(rawPath, true)) { emit(kind, 'pasteboardItems:' + uti); done = true; break; }
              }
            }
          }
        }
      } catch (e) { console.log(JSON.stringify({ ok: false, method: 'pasteboardItems', err: String(e) })); }
    }

    // Method 4: legacy direct dataForType on the pasteboard itself.
    if (!done) {
      const utis = [['public.png','png'],['public.jpeg','jpeg'],['public.tiff','tiff'],['com.compuserve.gif','gif'],['com.microsoft.bmp','bmp'],['com.adobe.pdf','pdf']];
      for (const [uti, kind] of utis) {
        const data = pb.dataForType(uti);
        if (data && !data.isNil() && data.length > 0) {
          if (data.writeToFileAtomically(rawPath, true)) { emit(kind, 'dataForType:' + uti); done = true; break; }
        }
      }
    }
  `;
  let resultJson = "";
  try {
    const result = await runCommand("osascript", ["-l", "JavaScript", "-e", script]);
    if (result.code !== 0) return undefined;
    resultJson = result.stdout.trim();
    if (!resultJson) return undefined;
    // The script may emit one or more JSON lines (errors before success).
    // The successful read is always the line with ok=true.
    const lines = resultJson.split(/\r?\n/).filter((l) => l.length > 0);
    let parsed: { ok?: boolean; kind?: string; method?: string } | undefined;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { ok?: boolean; kind?: string; method?: string };
        if (obj.ok) {
          parsed = obj;
          break;
        }
      } catch {
        /* ignore non-JSON noise */
      }
    }
    if (!parsed?.ok || !parsed.kind) return undefined;

    if (parsed.kind === "png") {
      return new Uint8Array(await readFile(rawPath));
    }
    // Transcode any non-PNG payload to PNG via sips so the pipeline only
    // has to deal with the four image MIME types we already accept.
    const conv = await runCommand("sips", ["-s", "format", "png", rawPath, "--out", pngPath]);
    if (conv.code !== 0) return undefined;
    return new Uint8Array(await readFile(pngPath));
  } catch {
    return undefined;
  } finally {
    for (const path of [rawPath, pngPath]) {
      try {
        await unlink(path);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * macOS clipboard → file bytes via AppleScript for a specific clipboard class
 * (e.g. `PNGf`, `TIFF`, `JPEG`, `PDF `). Writes to a temp file rather than
 * piping through stdout because AppleScript serialization corrupts CR/LF
 * bytes inside binary payloads.
 *
 * When `convertVia` is non-null we run macOS's built-in `sips` to transcode
 * the temp file into a PNG before reading the bytes back, so the rest of
 * the pipeline only ever sees one of the four MIME types we accept.
 */
function readMacClipboardClass(
  classCode: string,
  extension: string,
  convertVia: "png" | null,
): ClipboardProbe {
  return async () => {
    const stamp = `${Date.now()}-${process.pid}`;
    const tmp = join(tmpdir(), `duet-clipboard-${stamp}${extension}`);
    const script = [
      "set out to POSIX file " + JSON.stringify(tmp),
      "try",
      "  set fd to open for access out with write permission",
      "  set eof of fd to 0",
      `  write (the clipboard as \u00abclass ${classCode}\u00bb) to fd`,
      "  close access fd",
      '  return "ok"',
      "on error errMsg",
      "  try",
      "    close access fd",
      "  end try",
      '  return "err:" & errMsg',
      "end try",
    ].join("\n");

    let pngPath: string | undefined;
    try {
      const result = await runCommand("osascript", ["-e", script]);
      if (!result.stdout.startsWith("ok")) return undefined;

      if (convertVia === null) {
        return new Uint8Array(await readFile(tmp));
      }

      pngPath = join(tmpdir(), `duet-clipboard-${stamp}.png`);
      const conv = await runCommand("sips", ["-s", "format", "png", tmp, "--out", pngPath]);
      if (conv.code !== 0) return undefined;
      return new Uint8Array(await readFile(pngPath));
    } finally {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      if (pngPath) {
        try {
          await unlink(pngPath);
        } catch {
          /* ignore */
        }
      }
    }
  };
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
