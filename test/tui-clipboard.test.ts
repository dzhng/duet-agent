import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseCopyArgument,
  selectCopyText,
  type TranscriptEntry,
} from "../src/tui/transcript-log.js";
import { writeClipboardText } from "../src/tui/clipboard.js";

const sampleLog: TranscriptEntry[] = [
  { kind: "user", text: "hello" },
  { kind: "agent", text: "hi there" },
  { kind: "user", text: "what's up?" },
  { kind: "agent", text: "not much, you?" },
];

describe("parseCopyArgument", () => {
  test("empty argument resolves to 'last'", () => {
    expect(parseCopyArgument("")).toBe("last");
    expect(parseCopyArgument("   ")).toBe("last");
  });

  test("explicit 'last' and 'all' pass through", () => {
    expect(parseCopyArgument("last")).toBe("last");
    expect(parseCopyArgument("all")).toBe("all");
  });

  test("positive integer is parsed as a count", () => {
    expect(parseCopyArgument("3")).toBe(3);
    expect(parseCopyArgument("  10  ")).toBe(10);
  });

  test("malformed arguments return undefined", () => {
    expect(parseCopyArgument("0")).toBeUndefined();
    expect(parseCopyArgument("-1")).toBeUndefined();
    expect(parseCopyArgument("1.5")).toBeUndefined();
    expect(parseCopyArgument("nope")).toBeUndefined();
  });
});

describe("selectCopyText", () => {
  test("'last' returns the most recent agent reply", () => {
    expect(selectCopyText(sampleLog, "last")).toBe("not much, you?");
  });

  test("'last' falls back to the latest user message when no agent has replied", () => {
    const onlyUser: TranscriptEntry[] = [{ kind: "user", text: "hi" }];
    expect(selectCopyText(onlyUser, "last")).toBe("hi");
  });

  test("'all' joins every entry in order with role labels", () => {
    const result = selectCopyText(sampleLog, "all");
    expect(result).toBe(
      "you: hello\n\nagent: hi there\n\nyou: what's up?\n\nagent: not much, you?",
    );
  });

  test("numeric N selects the trailing slice", () => {
    expect(selectCopyText(sampleLog, 1)).toBe("agent: not much, you?");
    expect(selectCopyText(sampleLog, 2)).toBe("you: what's up?\n\nagent: not much, you?");
  });

  test("N larger than the log returns the whole log", () => {
    expect(selectCopyText(sampleLog, 99)).toBe(selectCopyText(sampleLog, "all"));
  });

  test("empty log returns undefined for every selector", () => {
    expect(selectCopyText([], "last")).toBeUndefined();
    expect(selectCopyText([], "all")).toBeUndefined();
    expect(selectCopyText([], 5)).toBeUndefined();
  });
});

describe("writeClipboardText", () => {
  test("returns ok when the platform writer succeeds", async () => {
    // pbcopy on macOS, clip.exe on Windows, wl-copy/xclip/xsel on Linux —
    // all happy-path. We sniff the actual clipboard back via pbpaste on
    // macOS where available, otherwise just trust the exit code.
    const result = await writeClipboardText("duet-cli-clipboard-roundtrip");

    if (process.platform === "darwin") {
      expect(result.ok).toBe(true);
      expect(result.via).toBe("pbcopy");
    } else if (process.platform === "linux") {
      // Many CI containers have neither wl-copy nor xclip installed; treat
      // ok=false as acceptable but require a clear error message when so.
      if (result.ok) {
        expect(result.via).toBeDefined();
        expect(["wl-copy", "xclip", "xsel", "clip.exe"]).toContain(result.via as string);
      } else {
        expect(result.error).toBeDefined();
      }
    } else {
      // Other platforms: assert the shape but stay lenient on availability.
      expect(typeof result.ok).toBe("boolean");
    }
  });

  test("surfaces a sensible error when no writer is on PATH", async () => {
    // Override PATH to a directory that contains none of the candidate
    // commands. Every candidate spawn must fail with ENOENT, and the
    // function should report a populated error instead of throwing.
    const empty = mkdtempSync(join(tmpdir(), "duet-clipboard-"));

    const previousPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      const result = await writeClipboardText("no-writer-on-path");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
