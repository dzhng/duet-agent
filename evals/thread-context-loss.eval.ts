import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "bun:test";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "opus-4.7";

/**
 * Repro of the dev-sessions "thread context loss" report (May 15, 2026).
 *
 * The fixture is the literal on-disk TurnState from a real Duet thread
 * session (`ms7cwhvgvnz304m8v59d21sg6986sfs1`) where the user reported the
 * AI "losing track" of earlier messages on the third turn. The user's last
 * question and the broken assistant reply are stripped — we keep only the
 * 38 prior messages (Ani's two asks + a David follow-up + all the
 * image-gen tool calls in between) and ask the assistant verbatim what it
 * sees in its message history.
 *
 * The bug hypothesis: image-heavy turns push the wire past the
 * `messageTokens` / `WIRE_BYTE_TRIGGER` thresholds, the observational
 * context transform advances `wireGuardHorizon.evictionHorizon`, and the
 * head messages (Ani's parent ask + slots/logos follow-up) get stripped
 * from what the provider actually receives. The model then truthfully
 * reports only the messages it still sees, which presents to the user as
 * "AI forgot what we were talking about".
 *
 * Pass condition: the response must reference Ani's earlier asks — the
 * Thanos framing, the gauntlet/stones, or the slot/logo correction. If
 * the runner has evicted those messages from the wire, none of these
 * substrings can appear.
 */
describe("thread context loss repro", () => {
  testIfDocker(
    "preserves Ani's earlier asks across an image-heavy thread",
    async () => {
      const fixturePath = join(import.meta.dir, "fixtures/session-thread-context-loss/state.json");
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
        state: TurnState;
      };

      const runner = new TurnRunner({
        model,
        mode: fixture.state.mode,
        skillDiscovery: { includeDefaults: false },
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));

      await runner.start({
        type: "start",
        state: fixture.state,
        mode: fixture.state.mode,
      });

      const terminal = await runner.turn({
        type: "prompt",
        message:
          "What do you see in the message history? Give me every user message currently in your context window, including who sent it and a one-line summary of what they asked.",
        behavior: "follow_up",
      });

      expect(terminal.type).toBe("complete");
      if (terminal.type !== "complete") throw new Error("expected complete terminal");
      expect(terminal.status).toBe("completed");

      const reply = (terminal.result ?? "").toLowerCase();
      // Diagnostics surface in the test runner's output so a regression is
      // self-documenting: the literal reply tells you whether the model saw
      // Ani's asks or only David's recent question.
      console.log("--- thread-context-loss reply ---\n" + (terminal.result ?? ""));
      const systemNotices = events
        .filter((event): event is Extract<TurnEvent, { type: "system" }> => event.type === "system")
        .map((event) => `[${event.level}] ${event.message}`);
      if (systemNotices.length > 0) {
        console.log("--- system notices ---\n" + systemNotices.join("\n"));
      }

      // The fixture contains three distinct user messages: Ani's parent
      // ask (Thanos framing), Ani's follow-up (slots/logos), and David's
      // "is the image done?". If the wire is intact, the model must be
      // able to attribute Ani's messages to Ani — not just pattern-match
      // "Thanos" off of disk artifacts and tool results, which it will
      // happily do even after eviction.
      const mentionsAniAsAuthor = reply.includes("ani") || reply.includes("ani@vibetm.ai");
      const mentionsAniContent =
        reply.includes("slots") || reply.includes("logos") || reply.includes("gauntlet");
      expect(mentionsAniAsAuthor).toBe(true);
      expect(mentionsAniContent).toBe(true);
    },
    180_000,
  );
});
