import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testIfDocker } from "./helpers/docker-only.js";
import {
  loadImageFromPath,
  looksLikeImageFilePath,
  MAX_IMAGE_BYTES,
  mimeTypeFromExtension,
  persistPastedImage,
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

  testIfDocker("persistPastedImage writes the bytes and returns the wire payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-paste-"));
    process.env.HOME = dir;
    const sessionId = "test-session";
    const png = new Uint8Array(64);
    png.set(PNG_HEADER, 0);
    const result = await persistPastedImage({
      sessionId,
      id: 1,
      bytes: png,
      mimeType: "image/png",
    });

    expect(result.id).toBe(1);
    expect(result.label).toBe("[Image #1]");
    expect(result.attachment.mimeType).toBe("image/png");
    expect(result.attachment.data).toBe(Buffer.from(png).toString("base64"));
    expect(result.path).toMatch(/paste-.*-1\.png$/);
    // Bytes round-trip on disk.
    const onDisk = readFileSync(result.path);
    expect(onDisk.equals(Buffer.from(png))).toBe(true);
  });

  testIfDocker("persistPastedImage rejects unsupported MIME types", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "duet-paste-"));
    await expect(
      persistPastedImage({
        sessionId: "t",
        id: 1,
        bytes: new Uint8Array([0x00]),
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow(/Unsupported image type/);
  });

  testIfDocker("persistPastedImage rejects empty payloads", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "duet-paste-"));
    await expect(
      persistPastedImage({
        sessionId: "t",
        id: 1,
        bytes: new Uint8Array(0),
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/Empty image bytes/);
  });

  testIfDocker("persistPastedImage enforces the 20MB cap", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "duet-paste-"));
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG_HEADER, 0);
    await expect(
      persistPastedImage({
        sessionId: "t",
        id: 1,
        bytes: big,
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/too large/);
  });

  testIfDocker("loadImageFromPath validates bytes and returns a wire payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-load-"));
    const bytes = new Uint8Array(64);
    bytes.set(PNG_HEADER, 0);
    const file = join(dir, "ok.png");
    writeFileSync(file, bytes);

    const pending = await loadImageFromPath({ cwd: dir, rawPath: "ok.png", id: 7 });
    expect(pending.id).toBe(7);
    expect(pending.label).toBe("[Image #7]");
    expect(pending.path).toBe(file);
    expect(pending.attachment.mimeType).toBe("image/png");
    expect(pending.attachment.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  testIfDocker("loadImageFromPath errors on missing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-load-"));
    await expect(loadImageFromPath({ cwd: dir, rawPath: "nope.png", id: 1 })).rejects.toThrow(
      /No file at/,
    );
  });

  testIfDocker("loadImageFromPath rejects files whose bytes are not image data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-load-"));
    const file = join(dir, "fake.png");
    writeFileSync(file, "this is not actually a PNG");
    await expect(loadImageFromPath({ cwd: dir, rawPath: "fake.png", id: 1 })).rejects.toThrow(
      /Unsupported image type/,
    );
  });
});
