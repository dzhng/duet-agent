import { describe, expect, test } from "bun:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractImagePathCandidates,
  looksLikeImageFilePath,
  mimeTypeFromExtension,
  resolveExistingImagePath,
  sniffImageMimeType,
} from "../src/tui/paste.js";

// Minimal magic-byte fixtures \u2014 just enough to exercise the sniff path. Real
// decoders are not required since we never re-encode the bytes; they pass
// through to the model as base64 verbatim.
const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);
const JPEG_HEADER = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_HEADER = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_HEADER = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("tui/paste", () => {
  test("sniffs supported image mime types from raw bytes", () => {
    expect(sniffImageMimeType(PNG_HEADER)).toBe("image/png");
    expect(sniffImageMimeType(JPEG_HEADER)).toBe("image/jpeg");
    expect(sniffImageMimeType(GIF_HEADER)).toBe("image/gif");
    expect(sniffImageMimeType(WEBP_HEADER)).toBe("image/webp");
  });

  test("returns undefined for unsupported clipboard payloads", () => {
    expect(sniffImageMimeType(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.from("hello world"))).toBeUndefined();
  });

  test("infers mime from common image extensions", () => {
    expect(mimeTypeFromExtension("/tmp/foo.png")).toBe("image/png");
    expect(mimeTypeFromExtension("foo.JPG")).toBe("image/jpeg");
    expect(mimeTypeFromExtension("foo.jpeg")).toBe("image/jpeg");
    expect(mimeTypeFromExtension("foo.gif")).toBe("image/gif");
    expect(mimeTypeFromExtension("foo.webp")).toBe("image/webp");
    expect(mimeTypeFromExtension("foo.pdf")).toBeUndefined();
    expect(mimeTypeFromExtension("README")).toBeUndefined();
  });

  test("looksLikeImageFilePath only matches single-line image paths", () => {
    expect(looksLikeImageFilePath("/Users/me/Desktop/screenshot.png")).toBe(
      "/Users/me/Desktop/screenshot.png",
    );
    expect(looksLikeImageFilePath('"/Users/me/Pictures/foo.jpg"')).toBe(
      "/Users/me/Pictures/foo.jpg",
    );
    expect(looksLikeImageFilePath("'/Users/me/Pictures/foo.jpg'")).toBe(
      "/Users/me/Pictures/foo.jpg",
    );
    expect(looksLikeImageFilePath("not a path")).toBeUndefined();
    expect(looksLikeImageFilePath("multi\nline\n/Users/me/foo.png")).toBeUndefined();
    expect(looksLikeImageFilePath("")).toBeUndefined();
  });

  test("looksLikeImageFilePath unescapes shell-escaped drag-and-drop paths", () => {
    // Ghostty / iTerm / Terminal escape spaces and parens when a file is
    // dragged into the prompt.
    expect(looksLikeImageFilePath("/Users/me/Desktop/Frame\\ 2147228872.png")).toBe(
      "/Users/me/Desktop/Frame 2147228872.png",
    );
    expect(looksLikeImageFilePath("/Users/me/Photos/Screenshot\\ \\(2026-05-09\\).jpg")).toBe(
      "/Users/me/Photos/Screenshot (2026-05-09).jpg",
    );
  });

  test("looksLikeImageFilePath decodes file:// URLs", () => {
    expect(looksLikeImageFilePath("file:///Users/me/Desktop/cat.png")).toBe(
      "/Users/me/Desktop/cat.png",
    );
    expect(looksLikeImageFilePath("file:///Users/me/Desktop/Frame%202147228872.png")).toBe(
      "/Users/me/Desktop/Frame 2147228872.png",
    );
  });

  test("extractImagePathCandidates picks image paths out of mixed text", () => {
    expect(extractImagePathCandidates("")).toEqual([]);
    expect(extractImagePathCandidates("no paths here")).toEqual([]);

    // Bare absolute path inside a sentence.
    expect(
      extractImagePathCandidates("please look at /Users/me/Desktop/cat.png and tell me"),
    ).toEqual(["/Users/me/Desktop/cat.png"]);

    // Shell-escaped drag path (the macOS screenshot-thumbnail-drag case).
    expect(
      extractImagePathCandidates(
        "/var/folders/3p/T/TemporaryItems/NSIRD_x/Screenshot\\ 2026-05-14\\ at\\ 10.40.png",
      ),
    ).toEqual([
      "/var/folders/3p/T/TemporaryItems/NSIRD_x/Screenshot\\ 2026-05-14\\ at\\ 10.40.png",
    ]);

    // Multiple candidates, including a file:// URL and a ~/ path.
    expect(
      extractImagePathCandidates("compare file:///Users/me/a.png with ~/Pictures/b.jpg please"),
    ).toEqual(["file:///Users/me/a.png", "~/Pictures/b.jpg"]);

    // Unsupported extensions are ignored.
    expect(extractImagePathCandidates("/Users/me/notes.txt")).toEqual([]);

    // URLs must not match their path component as if it were a local file.
    expect(extractImagePathCandidates("look at https://example.com/cat.png")).toEqual([]);
    expect(extractImagePathCandidates("http://example.com/foo.jpg")).toEqual([]);

    // Verbatim macOS screenshot-thumbnail drag strings, observed from two
    // separate user sessions. Both produced the same partial-escape shape:
    // every space inside the date is `\<space>`, but the space before
    // `PM.png` is bare. Copied here unmodified so a regression in the regex
    // fails the build against the exact bytes a real user typed.
    const screenshotDragFirst = String.raw`/var/folders/3p/k21gnpt573b8yy45xvy27nd00000gn/T/TemporaryItems/NSIRD_screencaptureui_gXlH78/Screenshot\ 2026-05-14\ at\ 10.40.28 PM.png`;
    expect(extractImagePathCandidates(screenshotDragFirst)).toEqual([screenshotDragFirst]);

    const screenshotDragSecond = String.raw`/var/folders/3p/k21gnpt573b8yy45xvy27nd00000gn/T/TemporaryItems/NSIRD_screencaptureui_eIuZLn/Screenshot\ 2026-05-14\ at\ 11.05.01 PM.png`;
    expect(extractImagePathCandidates(screenshotDragSecond)).toEqual([screenshotDragSecond]);
  });

  test("resolveExistingImagePath returns absolute path on disk, undefined when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-resolve-"));
    const real = join(dir, "real.png");
    writeFileSync(real, "");

    // Absolute path that exists → echoed back.
    expect(resolveExistingImagePath("/nowhere", real)).toBe(real);

    // Absolute path that does not exist → undefined (silent-miss gate).
    expect(resolveExistingImagePath("/nowhere", join(dir, "ghost.png"))).toBeUndefined();

    // Relative path resolves against cwd.
    expect(resolveExistingImagePath(dir, "real.png")).toBe(real);
  });
});
