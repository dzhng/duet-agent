import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runSendFeedbackCommand } from "../src/cli/send-feedback.js";

let originalBaseUrl: string | undefined;

beforeEach(() => {
  originalBaseUrl = process.env.DUET_APP_BASE_URL;
  process.env.DUET_APP_BASE_URL = "https://test";
});

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.DUET_APP_BASE_URL;
  else process.env.DUET_APP_BASE_URL = originalBaseUrl;
});

describe("duet send-feedback", () => {
  test("posts the positional argument as markdown content", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    await runSendFeedbackCommand(["the TUI flickers when resuming"], { fetch: fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://test/api/v1/feedback");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      content: "the TUI flickers when resuming",
      source: "duet-agent-cli",
    });
  });

  test("reads content from a file when --file is passed", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = await mkdtemp(join(tmpdir(), "duet-feedback-"));
    const filePath = join(root, "feedback.md");
    await writeFile(filePath, "# Bug report\n\nSomething is broken.\n");

    const calls: { body: string }[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await runSendFeedbackCommand(["--file", filePath], { fetch: fetchImpl });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      content: "# Bug report\n\nSomething is broken.",
      source: "duet-agent-cli",
    });
  });

  test("surfaces non-2xx responses as fatal errors", async () => {
    const fetchImpl = (async () =>
      new Response("server boom", { status: 500 })) as unknown as typeof fetch;

    const exit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exit__");
    }) as never;
    try {
      await expect(runSendFeedbackCommand(["broken"], { fetch: fetchImpl })).rejects.toThrow(
        "__exit__",
      );
      expect(exitCode).toBe(1);
    } finally {
      process.exit = exit;
    }
  });
});
