import { describe, expect } from "bun:test";
import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Reproduces a real Duet session where the agent made an empty "I'll wait
 * ~7 minutes and triage Codex/Vercel/CI bot comments" promise after opening
 * a chat-app PR, with no underlying state machine, cron, or other actual
 * waiting mechanism. The user (Walter) had to call it out two messages
 * later with "are you actually waiting?" before the agent set anything up.
 *
 * SOUL.md is explicit ("Don't promise what you haven't set up. If you say
 * 'I'll keep an eye on X,' you need to actually create the mechanism — a
 * cron job, a reminder, a note — before saying it"). The routing layer is
 * also explicit ("always create a state machine when the user asks for a
 * recurring or unbounded task — anything shaped like 'monitor X and do Y',
 * 'watch for X', 'keep checking X until Y', 'every N minutes/hours do X',
 * or any work with no natural finish line in a single turn"). A
 * post-PR-comment triage step falls squarely under that rule.
 *
 * Verbatim user messages from the original session (chat-app channel
 * `dev-sessions`, thread `j97bgrbhmdhmf8a97hm378h9mx86v9tw`, 2026-05-16):
 *
 *   [Walter, 13:05] Sometimes on web mobile there is an issue in the chats
 *     tab where it doesnt properly scroll. Please make sure the full layout
 *     composition is clean for desktop view as well S mobile (ideally we
 *     have as few html tags as needed for rendering our structure; dont to
 *     janky stuff as adding html elements via css etc).
 *
 *   [Walter, 13:15] they key for successfully accomplishing this task is
 *     to have a excellent mental (or drawn) model on how the different
 *     layout files + components stack etc and how to proerply handle
 *     scroll
 *
 *   [Agent reply ended with] "I'll wait ~7min and triage Codex/Vercel/CI
 *     bot comments on the PR."  ← empty promise, no mechanism set up
 *
 *   [Walter, 13:36] <AiMention /> are you actually waiting?
 *
 * This eval expects to FAIL on current routing behavior. Fix the routing
 * prompt / SOUL guidance until the agent reaches for
 * create_state_machine_definition before promising the wait.
 */
describe("promised waits are backed by state-machine setup", () => {
  testIfDocker(
    "agent backs 'wait ~7 min then triage PR bot comments' with a state machine, not a bare promise",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "auto",
        skillDiscovery: { includeDefaults: false },
        // Planning-only guard so the eval stays cheap: the agent cannot
        // actually run bash/gh/git. It CAN call planning tools
        // (create_state_machine_definition, todo_write). The PR fix work is
        // declared "already done" so the only remaining decision is how to
        // handle the promised post-PR wait.
        systemInstructions: dedent`
          You are in a planning-only eval. Do not call bash, read, edit,
          write, or any other coding tool. The chat-app fix in the user's
          message has ALREADY been pushed to staging as PR #1325 on
          aomni-com/chat-app — there is no code work left for you to do
          right now.

          Codex, Vercel, and CI bots will post their review comments on
          PR #1325 in roughly 5–7 minutes from now. You are expected to
          triage those comments once they arrive (read them, decide if
          they require action, reply or push fixes if needed). That
          triage cannot happen until the bots have actually posted, so
          it must be scheduled to run after a delay — not immediately
          in this turn.

          You CAN call create_state_machine_definition and todo_write.
          If you create a state machine, include a terminal state named
          "eval_done" with status "completed" so no real background
          work runs. Reply with a short status update describing what
          you did and what you scheduled for after this turn.
        `,
      });

      const toolCalls: Array<{ name: string; input: any }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call") return;
        if (step.status !== "running") return;
        toolCalls.push({ name: step.toolName, input: step.input });
      });

      // Turn 1 — verbatim from the live session.
      const { turn: firstTurn } = await startTurn(runner, {
        mode: "auto",
        prompt: dedent`
          Sometimes on web mobile there is an issue in the chats tab where
          it doesnt properly scroll. Please make sure the full layout
          composition is clean for desktop view as well S mobile (ideally
          we have as few html tags as needed for rendering our structure;
          dont to janky stuff as adding html elements via css etc).
        `,
      });
      await firstTurn;

      // Turn 2 — verbatim follow-up from the live session. The empty "I'll
      // wait ~7 min" promise lived inside the agent's reply to one of these
      // two turns. By the end of this turn the wait mechanism should exist.
      const second = await runner.turn({
        type: "prompt",
        message: dedent`
          they key for successfully accomplishing this task is to have a
          excellent mental (or drawn) model on how the different layout
          files + components stack etc and how to proerply handle scroll
        `,
        behavior: "follow_up",
      });
      // The turn ends in `sleep` when the agent wires a timer/poll as
      // firstState (the SM is actually waiting). It ends in `complete`
      // when the agent creates the SM but does not enter the wait this
      // turn — either form is acceptable at the turn-event level
      // because the actual kinds-of-states check below is what catches
      // a pure-agent SM that skipped the wait.
      expect(["complete", "sleep"]).toContain(second.type);

      const stateMachineCalls = toolCalls.filter(
        (call) => call.name === "create_state_machine_definition",
      );

      // PRIMARY ASSERTION — failing this is the exact bug the session
      // exposed: the agent ended its reply with "I'll wait ~7 min and
      // triage Codex/Vercel/CI bot comments" without scheduling that wait
      // anywhere. There must be a state machine standing up the wait+triage
      // step before the turn ends.
      expect(stateMachineCalls.length).toBeGreaterThanOrEqual(1);

      const definition = stateMachineCalls[0]?.input?.definition;
      expect(definition).toBeTruthy();

      // The wait itself must use a sleeping primitive (timer for one-shot,
      // poll for recurring). A pure-agent state machine isn't actually
      // "waiting" — it would just run the triage agent immediately.
      const kinds = new Set<string>(definition.states.map((s: { kind: string }) => s.kind));
      expect(kinds.has("timer") || kinds.has("poll")).toBe(true);

      // And there must be a follow-up agent state for the triage itself —
      // otherwise the state machine wakes up and does nothing.
      expect(kinds.has("agent")).toBe(true);
    },
    180_000,
  );
});
