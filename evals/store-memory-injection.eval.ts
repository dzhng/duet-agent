import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect } from "bun:test";
import dedent from "dedent";

import { writeEntry } from "../src/memory/store/index.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const rootCodename = "Zephyr-Cobalt-7Q2M";
const childPolicy = "POLARIS-LOCK-91X";
const childRule = "exactly two amber seals";

describe("inherited markdown-store memory injection", () => {
  testIfDocker(
    "injects root and child stores downward without leaking child memory upward",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "duet-store-injection-eval-"));
      const child = path.join(root, "child");
      const work = path.join(child, "work");
      await mkdir(work, { recursive: true });

      try {
        await writeEntry(path.join(root, ".agents", "memories"), {
          slug: "root-project-identity",
          version: 1,
          id: "mem_root_project_identity",
          kind: "note",
          createdAt: 1_000,
          headline: "Root project identity",
          content: dedent`
            # Root project identity

            The exact internal root-project codename is ${rootCodename}.
          `,
        });
        await writeEntry(path.join(child, ".agents", "memories"), {
          slug: "child-rollout-policy",
          version: 1,
          id: "mem_child_rollout_policy",
          kind: "note",
          createdAt: 2_000,
          headline: "Child rollout policy",
          content: dedent`
            # Child rollout policy

            The exact child rollout policy is ${childPolicy}: every canary deploy requires ${childRule}.
          `,
        });

        // Falsification (2026-07-23): replacing discovered stores with an
        // empty list made the model answer UNKNOWN for both planted facts,
        // failing the rootCodename assertion while still making zero calls.
        const nested = await askFromStore(
          work,
          dedent`
            Using only pinned project knowledge, reply with one short sentence containing:
            1. the exact internal root-project codename; and
            2. the exact child rollout policy identifier and its full canary rule.

            If either fact is unavailable, write UNKNOWN. Do not call tools.
          `,
        );
        expect(nested.toolCalls).toEqual([]);
        expect(nested.answer).toContain(rootCodename);
        expect(nested.answer).toContain(childPolicy);
        expect(nested.answer.toLowerCase()).toContain(childRule);

        const rootOnly = await askFromStore(
          root,
          dedent`
            Using only pinned project knowledge, state the exact internal root-project codename.
            Then report whether a child-specific rollout policy is available. If it is not in the
            supplied knowledge, write CHILD_POLICY_UNAVAILABLE. Do not call tools or guess.
          `,
        );
        expect(rootOnly.toolCalls).toEqual([]);
        expect(rootOnly.answer).toContain(rootCodename);
        expect(rootOnly.answer).toContain("CHILD_POLICY_UNAVAILABLE");
        expect(rootOnly.answer).not.toContain(childPolicy);
        expect(rootOnly.answer.toLowerCase()).not.toContain(childRule);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

async function askFromStore(
  cwd: string,
  prompt: string,
): Promise<{
  answer: string;
  toolCalls: Array<{ name: string; input: unknown }>;
}> {
  const runner = new TurnRunner({
    sessionId: `store-injection-${path.basename(cwd)}`,
    model,
    mode: "agent",
    cwd,
    memoryDbPath: false,
    systemPromptFiles: [],
    skillDiscovery: { includeDefaults: false },
    systemInstructions: dedent`
      This is a live memory-injection eval. Answer only from context already supplied to you.
      Do not call tools, inspect the filesystem, or invent missing facts. Keep the answer brief.
    `,
  });
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step" || event.step.type !== "tool_call_start") return;
    toolCalls.push({ name: event.step.toolName, input: event.step.input });
  });

  try {
    const terminal = await (await startTurn(runner, { mode: "agent", prompt })).turn;
    expect(terminal.type).toBe("complete");
    return {
      answer: terminal.type === "complete" ? (terminal.result ?? "") : "",
      toolCalls,
    };
  } finally {
    await runner.dispose();
  }
}
