import { describe, expect, test } from "bun:test";
import { applyRelayCommand } from "../src/tui/relay-command.js";

/**
 * `/relay` is an inline command users can drop anywhere in a prompt. The
 * transform must strip every occurrence, normalize the surrounding
 * whitespace, and append exactly one system-reminder block so the agent
 * receives a clean prompt plus the routing nudge.
 */
describe("applyRelayCommand", () => {
  test("no token leaves the message untouched", () => {
    const result = applyRelayCommand("prospect david at acme");
    expect(result.applied).toBe(false);
    expect(result.message).toBe("prospect david at acme");
  });

  test("partial matches inside other words do not trigger", () => {
    const result = applyRelayCommand("a /relayed message and /relay-runner notes");
    expect(result.applied).toBe(false);
    expect(result.message).toBe("a /relayed message and /relay-runner notes");
  });

  test("inline token in the middle is stripped and reminder appended", () => {
    const result = applyRelayCommand("monitor inbox /relay every day");
    expect(result.applied).toBe(true);
    expect(result.message.startsWith("monitor inbox every day\n\n")).toBe(true);
    expect(result.message).toContain("<system-reminder>");
    expect(result.message).toContain("relay mode");
    expect(result.message).toContain("</system-reminder>");
  });

  test("multiple tokens are all removed", () => {
    const result = applyRelayCommand("/relay outreach for david /relay");
    expect(result.applied).toBe(true);
    expect(result.message.startsWith("outreach for david\n\n")).toBe(true);
    // Only one reminder block, regardless of how many tokens were stripped.
    const matches = result.message.match(/<system-reminder>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("standalone /relay produces just the reminder", () => {
    const result = applyRelayCommand("/relay");
    expect(result.applied).toBe(true);
    expect(result.message.startsWith("<system-reminder>")).toBe(true);
    expect(result.message.trim().endsWith("</system-reminder>")).toBe(true);
  });

  test("token at the start strips cleanly without leaving a leading space", () => {
    const result = applyRelayCommand("/relay watch the build");
    expect(result.applied).toBe(true);
    expect(result.message.startsWith("watch the build\n\n")).toBe(true);
  });
});
