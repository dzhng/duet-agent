import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { assistantText } from "../core/serializer.js";
import type { TurnEvent, TurnOptions, TurnState, TurnTerminalEvent } from "../types/protocol.js";
import type { TurnRunnerControlResult } from "./tools.js";
import { usageFromMessages } from "./usage-accounting.js";

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  options?: TurnOptions;
  appendSystemPrompt?: string;
  skills?: Skill[];
  tools: AgentTool[];
}

export interface AgentWorkerResult {
  terminal: TurnTerminalEvent;
  control: TurnRunnerControlResult;
}

export type ActiveAgentSlot = "parent" | "state_machine_child";

export interface AgentWorkerRuntime {
  getActiveAgent(slot: ActiveAgentSlot): Agent | undefined;
  setActiveAgent(slot: ActiveAgentSlot, agent: Agent | undefined): void;
  createAgent(
    input: AgentWorkerInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent;
  emitAgentEvent(event: AgentEvent): void;
  consumeInterruptedTerminal(): TurnTerminalEvent | undefined;
}

export async function runAgentWorker(
  runtime: AgentWorkerRuntime,
  input: AgentWorkerInput,
  activeSlot: ActiveAgentSlot = "parent",
): Promise<AgentWorkerResult> {
  if (runtime.getActiveAgent(activeSlot)) {
    const description = activeSlot === "parent" ? "parent agent" : "state-machine child agent";
    throw new Error(`Cannot start a ${description} while another ${description} is active.`);
  }

  let control: TurnRunnerControlResult = { type: "none" };
  const agent = runtime.createAgent(input, (result) => {
    control = result;
  });
  runtime.setActiveAgent(activeSlot, agent);

  const unsubscribe = agent.subscribe((event) => runtime.emitAgentEvent(event));
  let interruptedDuringPrompt: TurnTerminalEvent | undefined;
  try {
    await agent.prompt(input.prompt);
  } catch (error) {
    interruptedDuringPrompt = runtime.consumeInterruptedTerminal();
    if (!interruptedDuringPrompt) {
      throw error;
    }
  } finally {
    unsubscribe();
    runtime.setActiveAgent(activeSlot, undefined);
  }

  const interrupted = interruptedDuringPrompt ?? runtime.consumeInterruptedTerminal();
  if (interrupted) {
    return { control, terminal: interrupted };
  }

  const messages = agent.state.messages;
  const usage = usageFromMessages(messages.slice(input.state.agent.messages.length));
  const status = agent.state.errorMessage ? "failed" : "completed";
  const state = {
    ...input.state,
    status,
    agent: {
      ...input.state.agent,
      status,
      messages,
    },
  } satisfies TurnState;

  return {
    control,
    terminal: {
      type: "complete",
      status,
      state,
      result: assistantText(messages),
      error: agent.state.errorMessage,
      usage,
    },
  };
}

export function emitAgentEvent(event: AgentEvent, emit: (event: TurnEvent) => void): void {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent;
      switch (update.type) {
        case "text_delta":
          emit({ type: "step", step: { type: "text_delta", delta: update.delta } });
          return;
        case "thinking_delta":
          emit({ type: "step", step: { type: "reasoning_delta", delta: update.delta } });
          return;
        case "text_end":
          emit({ type: "step", step: { type: "text", text: update.content } });
          return;
        case "thinking_end":
          emit({ type: "step", step: { type: "reasoning", text: update.content } });
          return;
      }
      return;
    }
    case "tool_execution_start":
      emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          status: "running",
          input: event.args,
        },
      });
      return;
    case "tool_execution_end":
      emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          status: event.isError ? "error" : "completed",
          output: event.result?.content,
        },
      });
      return;
  }
}
