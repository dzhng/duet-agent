import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  isTransientServerError,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
} from "../src/turn-runner/transient-error.js";
import { createAssistantMessage } from "./helpers/messages.js";

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
