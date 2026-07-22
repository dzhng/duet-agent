import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseArgs, requestTypeForCapability, usesLanguageImagePath } from "../src/cli/model.js";

// Bad flags route through `fail()`, which calls process.exit(1). Patch it to
// throw so the pure parser tests can assert on the error path without exiting.
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

describe("parseArgs", () => {
  let exitSpy: ReturnType<typeof spyOn> | undefined;
  let errorSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  test("parses a family model, type, image and numeric flags", () => {
    const parsed = parseArgs([
      "-m",
      "sol",
      "--type",
      "image",
      "--image",
      "src.png",
      "-o",
      "art.png",
      "--system",
      "be terse",
      "--size",
      "1024x1024",
      "--n",
      "3",
      "--seed",
      "7",
      "--duration",
      "5",
      "--fps",
      "24",
      "a fox",
      "in snow",
    ]);
    expect(parsed.model).toBe("sol");
    expect(parsed.type).toBe("image");
    expect(parsed.imagePath).toBe("src.png");
    expect(parsed.out).toBe("art.png");
    expect(parsed.system).toBe("be terse");
    expect(parsed.size).toBe("1024x1024");
    expect(parsed.n).toBe(3);
    expect(parsed.seed).toBe(7);
    expect(parsed.duration).toBe(5);
    expect(parsed.fps).toBe(24);
    expect(parsed.prompt).toBe("a fox in snow");
    expect(parsed.help).toBe(false);
  });

  test("--help sets the help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("rejects an unknown option", () => {
    expect(() => parseArgs(["--nope"])).toThrow(ExitCalled);
  });

  test("rejects an invalid --type", () => {
    expect(() => parseArgs(["--type", "audio"])).toThrow(ExitCalled);
  });

  test("rejects a flag missing its value", () => {
    expect(() => parseArgs(["--model"])).toThrow(ExitCalled);
  });

  test("rejects a value option followed by another flag", () => {
    expect(() => parseArgs(["-m", "--type", "image"])).toThrow(ExitCalled);
  });
});

describe("requestTypeForCapability", () => {
  test("image and video map straight through", () => {
    expect(requestTypeForCapability("image")).toBe("image");
    expect(requestTypeForCapability("video")).toBe("video");
  });

  test("language and other capabilities default to text", () => {
    expect(requestTypeForCapability("language")).toBe("text");
    expect(requestTypeForCapability("embedding")).toBe("text");
    expect(requestTypeForCapability(undefined)).toBe("text");
  });
});

describe("usesLanguageImagePath", () => {
  test("nano-banana style language models route through generateText/files", () => {
    // google/gemini-2.5-flash-image is catalogued as `language` but emits
    // images; a --type image request must use the language image path.
    expect(usesLanguageImagePath("language")).toBe(true);
  });

  test("dedicated image models use the generateImage path", () => {
    expect(usesLanguageImagePath("image")).toBe(false);
  });
});
