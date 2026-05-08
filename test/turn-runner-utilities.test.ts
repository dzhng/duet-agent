import { describe, expect, test } from "bun:test";
import {
  parseJsonObject,
  parseStructuredOutput,
  renderTemplate,
  runShellCommand,
  ShellCommandError,
} from "../src/turn-runner/shell-state-handle.js";
import { addUsage, usageFromMessages } from "../src/turn-runner/usage-accounting.js";
import { createAssistantMessage } from "./helpers/messages.js";

describe("turn-runner shell execution utilities", () => {
  test("parses structured output values", () => {
    expect(parseStructuredOutput('{"id":42,"ok":true}')).toEqual({ id: 42, ok: true });
    expect(parseStructuredOutput("done")).toEqual({ result: "done" });
    expect(parseStructuredOutput("7")).toEqual({ result: 7 });
    expect(parseStructuredOutput("")).toEqual({});
  });

  test("parses only JSON objects for poll output", () => {
    expect(parseJsonObject('{"ready":true}')).toEqual({ ready: true });
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject('"ready"')).toEqual({});
    expect(parseJsonObject("not json")).toEqual({});
  });

  test("renders nested input paths and serializes non-string values", () => {
    const rendered = renderTemplate(
      "send {{ input.user.name }} {{ input.count }} {{ input.missing }}",
      {
        user: { name: "Ada" },
        count: 3,
      },
    );

    expect(rendered).toBe("send Ada 3 ");
  });

  test("captures streamed stdout and stderr when aborted", async () => {
    const abortController = new AbortController();
    const command = "printf partial-out; printf partial-err >&2; sleep 2";
    const result = runShellCommand(command, { cwd: process.cwd(), signal: abortController.signal });

    await new Promise((resolve) => setTimeout(resolve, 50));
    abortController.abort();

    await expect(result).rejects.toMatchObject({
      output: {
        stdout: "partial-out",
        stderr: "partial-err",
      },
    });
  });

  test("inherits DUET_API_KEY from process.env into spawned bash scripts", async () => {
    // The CLI loads DUET_API_KEY into process.env (from the shared duet env
    // file or directly from the user's env) and the turn runner shells out
    // through runShellCommand. Bash scripts driven by script-state machines
    // must see that token so they can authenticate against duet.so just like
    // the agent does — guarded here against an accidental `env: {}` regression
    // in the spawn options.
    const previous = process.env.DUET_API_KEY;
    process.env.DUET_API_KEY = "duet_gt_inherit_marker";
    try {
      const result = await runShellCommand('printf "%s" "$DUET_API_KEY"', {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
      expect(result).toEqual({
        stdout: "duet_gt_inherit_marker",
        stderr: "",
        exitCode: 0,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.DUET_API_KEY;
      } else {
        process.env.DUET_API_KEY = previous;
      }
    }
  });

  test("honors success codes and reports non-success output", async () => {
    await expect(
      runShellCommand("printf ok; exit 7", {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        successCodes: [7],
      }),
    ).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 7 });

    try {
      await runShellCommand("printf nope; exit 9", {
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
      throw new Error("Expected shell command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ShellCommandError);
      expect(error).toMatchObject({ output: { stdout: "nope", exitCode: 9 } });
    }
  });
});

describe("turn-runner usage accounting", () => {
  test("adds protocol and provider usage values", () => {
    const total = addUsage(
      {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      {
        input: 5,
        output: 7,
        cacheRead: 11,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.13 },
      },
    );

    expect(
      addUsage(total, {
        input: 1,
        output: 4,
        cacheRead: 6,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toEqual({
      input: 8,
      output: 14,
      totalTokens: 22,
      cacheRead: 17,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.13 },
    });
  });

  test("extracts usage from assistant messages", () => {
    const usage = usageFromMessages([
      { role: "user", content: "hello", timestamp: 1 },
      createAssistantMessage({
        usage: {
          input: 4,
          output: 8,
          cacheRead: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      }),
    ]);

    expect(usage).toEqual({
      input: 4,
      output: 8,
      totalTokens: 12,
      cacheRead: 2,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    });
  });
});
