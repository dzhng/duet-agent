import { expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { createStateMachineState } from "./helpers/turn-runner-protocol.js";

class ControlBoundaryRunner extends TurnRunner {
  calls = 0;
  firstControl?: "ask" | "sleep";
  terminalSeenOnSecondCall = false;
  protected override createAgent(
    input: AgentConfigInput,
    control?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    const agent = super.createAgent(input, control);
    agent.streamFunction = () => {
      this.calls++;
      if (this.calls === 2)
        this.terminalSeenOnSecondCall =
          this.getState()?.stateMachine?.terminal?.status === "completed";
      if (this.calls > 5) throw new Error("Unexpected model loop");
      const emitsControl = this.firstControl ? this.calls === 1 : this.calls <= 2;
      const message = emitsControl
        ? createAssistantMessage({
            extraContent: [
              {
                type: "toolCall",
                id: `select-${this.calls}`,
                name:
                  this.firstControl === "ask" ? "ask_user_question" : "select_state_machine_state",
                arguments:
                  this.firstControl === "ask"
                    ? { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] }
                    : {
                        decision: {
                          state:
                            this.firstControl === "sleep"
                              ? "wait_before_retry"
                              : "meeting_scheduled",
                        },
                      },
              },
            ],
          })
        : createAssistantMessage({ text: "Confirmed." });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({ type: "done", reason: emitsControl ? "toolUse" : "stop", message }),
      );
      return stream;
    };
    return agent;
  }
}

for (const behavior of ["follow_up", "steer"] as const) {
  for (const boundary of ["tool_call_start", "tool_call"] as const) {
    test(`${behavior} arriving at ${boundary} runs after the accepted state selection`, async () => {
      const runner = new ControlBoundaryRunner({
        model: "anthropic:claude-opus-4-7",
        memoryDbPath: false,
        skillDiscovery: { includeDefaults: false },
      });
      const events: TurnEvent[] = [];
      let followUp: ReturnType<TurnRunner["turn"]> | undefined;
      runner.subscribe((event) => {
        events.push(event);
        if (!followUp && event.type === "step" && event.step.type === boundary) {
          followUp = runner.turn({ type: "prompt", message: "Confirm completion", behavior });
        }
      });
      await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
      const terminal = await runner.turn({
        type: "prompt",
        message: "Finish.",
        behavior: "follow_up",
      });
      expect(await followUp).toBe(terminal);
      expect(runner.terminalSeenOnSecondCall).toBe(true);
      expect(terminal.type).toBe("complete");
      expect(JSON.stringify(events)).not.toContain("more than one control result");
      expect(
        terminal.state.agent.messages.filter(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Confirm completion"),
        ),
      ).toHaveLength(1);
      expect(terminal.state.queuedCommands).toEqual([]);
    });
  }
}

for (const terminalType of ["ask", "sleep"] as const) {
  test(`input retained across ${terminalType} is consumed once on the next turn`, async () => {
    const runner = new ControlBoundaryRunner({
      model: "anthropic:claude-opus-4-7",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
    runner.firstControl = terminalType;
    let injected = false;
    runner.subscribe((event) => {
      if (!injected && event.type === "step" && event.step.type === "tool_call") {
        injected = true;
        void runner.turn({ type: "prompt", message: "Queued follow-up", behavior: "follow_up" });
      }
    });
    await runner.start({ type: "start", state: createStateMachineState("wait_before_retry") });
    const suspended = await runner.turn({
      type: "prompt",
      message: "Wait.",
      behavior: "follow_up",
    });
    expect(suspended.type).toBe(terminalType);
    runner.firstControl = undefined;
    runner.calls = 0;
    const finished = await runner.turn({
      type: "prompt",
      message: "Finish now.",
      behavior: "follow_up",
    });
    expect(
      finished.state.agent.messages.filter(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Queued follow-up"),
      ),
    ).toHaveLength(1);
    expect(finished.state.queuedCommands).toEqual([]);
  });
}
