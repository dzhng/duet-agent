import type { Model } from "@mariozechner/pi-ai";
import { Harness } from "../../src/harness/harness.js";
import type { HarnessEvent, HarnessRun } from "../../src/types/protocol.js";
import type { StateMachineDefinition } from "../../src/types/state-machine.js";

const model = {} as Model<any>;

export function createHarness(): { harness: Harness; events: HarnessEvent[] } {
  const harness = new Harness({
    harnessModel: model,
    skillDiscovery: { includeDefaults: false },
  });
  const events: HarnessEvent[] = [];
  harness.subscribe((event) => events.push(event));
  return { harness, events };
}

export function createStateMachineRun(currentState: string): HarnessRun {
  return {
    agent: {
      status: "running",
      messages: [],
    },
    stateMachine: {
      status: "running",
      prompt: "Prospect Ada until she books a meeting.",
      currentState,
      state: {},
      states: {},
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

export function createOutreachStateMachine(): StateMachineDefinition {
  return {
    name: "conference_outreach",
    states: [
      {
        kind: "agent",
        name: "research_prospect",
        instructions: "Research the prospect and company.",
      },
      {
        kind: "script",
        name: "send_email",
        command: "scripts/send-email.sh '{{ state.email }}'",
      },
      {
        kind: "poll",
        name: "poll_email_reply",
        intervalMs: 300_000,
        poll: {
          kind: "script",
          command: "scripts/check-email-reply.sh '{{ state.email }}'",
        },
      },
      {
        kind: "agent",
        name: "classify_reply",
        instructions: "Classify the email reply and update state.",
      },
      {
        kind: "terminal",
        name: "meeting_scheduled",
        status: "completed",
      },
    ],
  };
}
