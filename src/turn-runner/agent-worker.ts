import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { assistantText } from "../core/serializer.js";
import type { TurnEvent, TurnOptions, TurnState, TurnTerminalEvent } from "../types/protocol.js";
import type { TodoWriteToolDetails, TurnRunnerControlResult } from "./tools.js";
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
  if (activeSlot === "parent" && runtime.getActiveAgent("parent")) {
    throw new Error("Cannot start a parent agent while another parent agent is active.");
  }
  if (activeSlot === "state_machine_child" && runtime.getActiveAgent("state_machine_child")) {
    throw new Error(
      "Cannot start a state-machine child agent while another child agent is active.",
    );
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

export function emitAgentEvent(
  event: AgentEvent,
  emit: (event: TurnEvent) => void,
  removeFollowUpPrompt: (prompt: string) => void,
): void {
  if (event.type === "message_start" && event.message.role === "user") {
    removeFollowUpPrompt(agentMessageText(event.message));
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      emit({ type: "step", step: { type: "text_delta", delta: update.delta } });
    }
    if (update.type === "thinking_delta") {
      emit({ type: "step", step: { type: "reasoning_delta", delta: update.delta } });
    }
    if (update.type === "text_end") {
      emit({ type: "step", step: { type: "text", text: update.content } });
    }
    if (update.type === "thinking_end") {
      emit({ type: "step", step: { type: "reasoning", text: update.content } });
    }
  }
  if (event.type === "tool_execution_start") {
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
  }
  if (event.type === "tool_execution_end") {
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
  }
}

export function isTurnRunnerControlResult(value: unknown): value is TurnRunnerControlResult {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = value.type;
  return (
    type === "none" ||
    type === "ask_user_question" ||
    type === "create_state_machine_definition" ||
    type === "select_state_machine_state" ||
    type === "prompt_state_machine_agent"
  );
}

export function isTodoWriteToolDetails(value: unknown): value is TodoWriteToolDetails {
  return Boolean(
    value && typeof value === "object" && "type" in value && value.type === "todo_write",
  );
}

function agentMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}
