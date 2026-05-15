import { describe, expect, test } from "bun:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  isTransientServerError,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
  type TransientRetryPolicy,
} from "../src/turn-runner/transient-error.js";
import { createAssistantMessage } from "./helpers/messages.js";

class RetryHarnessRunner extends TurnRunner {
  async runRetryLoop(agent: Agent, policy?: TransientRetryPolicy): Promise<void> {
    await this.retryTransientServerErrors(agent, policy);
  }
}

const failureAssistant = (errorMessage: string) =>
  createAssistantMessage({ errorMessage, stopReason: "error" });

describe("isTransientServerError", () => {
  test.each([
    `500 {"error":"[Request ID: x] Server Error"}`,
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "Internal Server Error",
    "upstream connect error",
    "fetch failed",
    "socket hang up",
    "ETIMEDOUT",
    "Request timed out after 30s",
    "Overloaded — please retry shortly.",
    "provider returned error",
    "Websocket closed unexpectedly",
    "other side closed connection",
    "ended without sending chunks",
    "Anthropic stream ended before message_stop",
    "http2 request did not get a response",
    "Retry delay of 90s exceeded maxRetryDelayMs cap",
    "429 Too Many Requests",
    "Rate limit exceeded",
  ])("retries: %s", (message) => {
    expect(isTransientServerError(message)).toBe(true);
  });

  test.each([
    "400 Bad Request",
    "401 Unauthorized",
    "403 Forbidden",
    "404 Not Found",
    "prompt is too long: 213462 tokens > 200000 maximum",
    "",
    undefined,
  ])("does not retry: %s", (message) => {
    expect(isTransientServerError(message ?? undefined)).toBe(false);
  });
});

describe("lastMessageIsTransientFailure", () => {
  test("true when last assistant has stopReason=error and transient body", () => {
    expect(lastMessageIsTransientFailure([failureAssistant("500 Server Error")])).toBe(true);
  });

  test("false when last assistant is not a transient error", () => {
    expect(lastMessageIsTransientFailure([failureAssistant("400 Bad Request")])).toBe(false);
  });

  test("false when transcript is empty", () => {
    expect(lastMessageIsTransientFailure([])).toBe(false);
  });

  test("false when last message is a user turn", () => {
    expect(
      lastMessageIsTransientFailure([
        failureAssistant("500"),
        { role: "user", content: "follow up", timestamp: 1 },
      ]),
    ).toBe(false);
  });
});

describe("transientRetryDelayMs", () => {
  test("grows exponentially per attempt within max", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 15_000 };
    const a1 = transientRetryDelayMs(1, policy);
    const a2 = transientRetryDelayMs(2, policy);
    const a3 = transientRetryDelayMs(3, policy);
    expect(a1).toBeGreaterThanOrEqual(1_000);
    expect(a1).toBeLessThan(1_500);
    expect(a2).toBeGreaterThanOrEqual(2_000);
    expect(a2).toBeLessThan(3_000);
    expect(a3).toBeGreaterThanOrEqual(4_000);
    expect(a3).toBeLessThan(6_000);
  });

  test("caps at maxDelayMs (plus jitter ceiling)", () => {
    const policy = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 5_000 };
    for (let attempt = 5; attempt < 10; attempt++) {
      expect(transientRetryDelayMs(attempt, policy)).toBeLessThanOrEqual(5_000 * 1.26);
    }
  });

  test("default policy matches pi-coding-agent AgentSession (3 retries, 2s base)", () => {
    expect(DEFAULT_TRANSIENT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(DEFAULT_TRANSIENT_RETRY_POLICY.baseDelayMs).toBe(2_000);
    const delay = transientRetryDelayMs(1, DEFAULT_TRANSIENT_RETRY_POLICY);
    expect(delay).toBeGreaterThanOrEqual(2_000);
    expect(delay).toBeLessThan(3_000);
  });
});

describe("retryTransientServerErrors", () => {
  /**
   * Build a minimal Agent-shaped fixture that lets a test drive the
   * sequence of messages each `agent.continue()` call appends.
   *
   * `continueImpls[i]` is invoked on the i-th continue call and
   * receives the live messages array to mutate plus a function to set
   * `agent.state.errorMessage` (mirrors how pi-agent records the tail
   * error state for the retry loop to read).
   */
  function makeFakeAgent(
    seedMessages: AgentMessage[],
    initialError: string,
    continueImpls: Array<
      (messages: AgentMessage[], setError: (error: string | undefined) => void) => void
    >,
  ): Agent & { continueCalls: number } {
    const state = { errorMessage: initialError as string | undefined, messages: [...seedMessages] };
    let calls = 0;
    const agent = {
      state,
      get continueCalls() {
        return calls;
      },
      async continue() {
        const impl = continueImpls[calls];
        calls += 1;
        if (!impl) throw new Error("Fake agent has no more continue() implementations queued.");
        impl(state.messages, (error) => {
          state.errorMessage = error;
        });
      },
    };
    return agent as unknown as Agent & { continueCalls: number };
  }

  function retryAttemptLabels(events: TurnEvent[]): string[] {
    return events
      .filter(
        (event): event is Extract<TurnEvent, { type: "system" }> =>
          event.type === "system" && event.message.startsWith("Upstream error"),
      )
      .map((event) => {
        const match = /attempt (\d+)\/(\d+)/.exec(event.message);
        return match ? `${match[1]}/${match[2]}` : event.message;
      });
  }

  const fastPolicy: TransientRetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
  };

  test("counter resets after the agent makes progress between failures", async () => {
    const runner = new RetryHarnessRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const failure = (id: number) =>
      createAssistantMessage({
        stopReason: "error",
        errorMessage: `500 Server Error #${id}`,
        timestamp: id,
      });

    // Initial state: prompt() already failed once (the implicit "attempt 1/3"),
    // and the failure is the tail of the transcript.
    const agent = makeFakeAgent(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }, failure(1)],
      "500 Server Error #1",
      [
        // Retry #1: agent makes forward progress (one successful
        // intermediate assistant message) and then fails again. This
        // is the case the user reported: the second failure should
        // reset the retry counter because the agent did real work in
        // between.
        (messages, setError) => {
          messages.push(createAssistantMessage({ text: "made some progress", timestamp: 2 }));
          messages.push(failure(3));
          setError("500 Server Error #3");
        },
        // Retry #2: clean success — clears the error and the loop exits.
        (messages, setError) => {
          messages.push(createAssistantMessage({ text: "finally ok", timestamp: 4 }));
          setError(undefined);
        },
      ],
    );

    await runner.runRetryLoop(agent, fastPolicy);

    expect(agent.continueCalls).toBe(2);
    // Both retry log lines should read "attempt 2/3": the first
    // failure burned the implicit attempt 1, and the second failure
    // resets to attempt 1 because the agent emitted an intermediate
    // success between them.
    expect(retryAttemptLabels(events)).toEqual(["2/3", "2/3"]);
  });

  test("counter keeps incrementing when continue() only emits another failure (no progress)", async () => {
    const runner = new RetryHarnessRunner({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
    const events: TurnEvent[] = [];
    runner.subscribe((event) => events.push(event));

    const failure = (id: number) =>
      createAssistantMessage({
        stopReason: "error",
        errorMessage: `500 Server Error #${id}`,
        timestamp: id,
      });

    const agent = makeFakeAgent(
      [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }, failure(1)],
      "500 Server Error #1",
      [
        // Retry #1: another failure, no intermediate progress.
        (messages, setError) => {
          messages.push(failure(2));
          setError("500 Server Error #2");
        },
        // Retry #2: another failure, still no progress. The loop hits
        // maxAttempts here and exits.
        (messages, setError) => {
          messages.push(failure(3));
          setError("500 Server Error #3");
        },
      ],
    );

    await runner.runRetryLoop(agent, fastPolicy);

    expect(agent.continueCalls).toBe(2);
    expect(retryAttemptLabels(events)).toEqual(["2/3", "3/3"]);
  });
});
