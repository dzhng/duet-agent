import dedent from "dedent";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";

const model = process.env.EVAL_MODEL ?? "duet-gateway:zai/glm-4.7";

function trace(label: string, runner: TurnRunner) {
  runner.subscribe((event: TurnEvent) => {
    if (event.type !== "step") return;
    const origin = event.origin ? `[sub:${event.origin.state}]` : "[parent]";
    const step = event.step;
    if (step.type === "reasoning") {
      console.log(`${label} ${origin} REASONING: ${step.text}`);
    } else if (step.type === "text") {
      console.log(`${label} ${origin} TEXT: ${step.text}`);
    } else if (step.type === "tool_call" && step.status === "running") {
      console.log(`${label} ${origin} TOOL ${step.toolName}: ${JSON.stringify(step.input)}`);
    }
  });
}

async function routing() {
  console.log("\n========== ROUTING ==========");
  const runner = new TurnRunner({
    model,
    mode: "auto",
    skillDiscovery: { includeDefaults: false },
    systemInstructions: dedent`
      You are in a planning-only eval. Do not read, edit, or run anything.
      Use exactly one planning tool to register a plan that matches the
      user's request. If you create a state machine, define a terminal
      state named "eval_done" with status "completed" and pass firstState
      "eval_done" so no real work runs. After the planning tool call,
      respond with exactly: PLAN_REGISTERED
    `,
  });
  trace("ROUTING", runner);
  const { turn } = await startTurn(runner, {
    mode: "auto",
    prompt: dedent`
      I want to land the tui/app.ts refactor on branch refactor/tui-app-split.
      The work breaks down into:

      Phase 1: extract layout.ts (pure layout builder, no shared state).
      Phase 2: carve ten controller modules out of the 2750-line mutable
      closure in app.ts — one module per controller (input, keymap,
      viewport, status, search, palette, theme, focus, prompt, history).
      Phase 3: build roughly thirty real-TUI tests across five new test
      files — one file per surface (rendering, keymap, search, palette,
      status).

      That is a multi-hour effort with deep wiring risk on every step and
      you should expect it to span sessions. Register the plan so the work
      survives the session boundary and each unit lands in its own clean
      diff.
    `,
  });
  const terminal = await turn;
  console.log("ROUTING terminal.type:", terminal.type);
}

async function ack() {
  console.log("\n========== TERMINAL ACK ==========");
  const runner = new TurnRunner({
    model,
    mode: "auto",
    skillDiscovery: { includeDefaults: false },
    systemInstructions: dedent`
      You are in an eval. Do not read, edit, or run anything outside
      the state-machine tools. Follow this script exactly:

      1. Create a state machine named "primary_followup_demo" with
         two states: an agent state named "noop" whose prompt is
         "reply with the single word: ok", and a terminal state
         named "primary_done" with status "completed". Use
         firstState "noop" so the runner starts noop immediately
         after the create call. After "noop" completes, select
         "primary_done" via select_state_machine_state — selecting
         a terminal state by name is how you end the machine.
      2. The runner will then wake you with the terminal details for
         "primary_done". On that SM1 acknowledgment turn, create a
         second state machine named "followup_after_terminal" whose
         definition has at least one agent state and a terminal
         state named "followup_done" with status "completed". Use
         firstState "followup_done" so no real work runs. Do NOT
         reply with any text on this SM1 ack turn — the only
         action is the create_state_machine_definition call.
      3. SM2 will go terminal immediately (firstState was the
         terminal). The runner will then wake you a second time
         with the SM2 terminal details. On that SM2 acknowledgment
         turn, reply to the user with EXACTLY this text and nothing
         else: FOLLOWUP_REGISTERED
      4. Do not call select_state_machine_state on either
         acknowledgment turn.
      5. Make exactly one create_state_machine_definition call per
         state machine — do not retry or amend the definition.
    `,
  });
  trace("ACK", runner);
  const { turn } = await startTurn(runner, {
    mode: "auto",
    prompt: "Run the primary_followup_demo script.",
  });
  const terminal = await turn;
  console.log("ACK terminal.type:", terminal.type);
}

const which = process.argv[2] ?? "all";
if (which === "routing" || which === "all") await routing();
if (which === "ack" || which === "all") await ack();
