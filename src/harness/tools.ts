import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { HarnessMode } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineState,
} from "../types/state-machine.js";

export type StateMachineAgentStateOverride = Partial<
  Pick<
    StateMachineAgentState,
    "prompt" | "contextScope" | "allowedSkills" | "options" | "maxTurns" | "outputSchema"
  >
>;

export type StateMachineScriptStateOverride = Partial<
  Pick<StateMachineScriptState, "command" | "cwd" | "timeoutMs" | "successCodes">
>;

export type StateMachinePollStateOverride = Partial<
  Pick<StateMachinePollState, "intervalMs" | "timeoutMs" | "poll">
>;

export type StateMachineStateOverride =
  | { kind: "agent"; state: StateMachineAgentStateOverride }
  | { kind: "script"; state: StateMachineScriptStateOverride }
  | { kind: "poll"; state: StateMachinePollStateOverride };

export interface HarnessToolsResultRef {
  current: HarnessControlResult;
}

const stateMachineDefinitionSchema = Type.Object({
  name: Type.String(),
  prompt: Type.String(),
  states: Type.Array(Type.Any()),
});

const createDefinitionSchema = Type.Object({
  definition: stateMachineDefinitionSchema,
  firstState: Type.Optional(Type.String()),
});

type CreateDefinitionParams = Static<typeof createDefinitionSchema>;
type ToolStateMachineDefinition = CreateDefinitionParams["definition"];

const selectStateSchema = Type.Object({
  decision: Type.Object({
    kind: Type.Union([Type.Literal("run_state"), Type.Literal("terminal"), Type.Literal("fail")]),
    state: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    override: Type.Optional(Type.Any()),
  }),
});

type SelectStateParams = Static<typeof selectStateSchema>;
type ToolRunnerDecision = SelectStateParams["decision"];

export type StateMachineRunnerDecision =
  | (ToolRunnerDecision & {
      kind: "run_state";
      state: string;
      override?: StateMachineStateOverride;
    })
  | (ToolRunnerDecision & { kind: "terminal"; state: string })
  | (ToolRunnerDecision & { kind: "fail"; reason: string });

export type HarnessControlResult =
  | { type: "none" }
  | ({
      type: "create_state_machine_definition";
      definition: ToolStateMachineDefinition;
    } & Pick<CreateDefinitionParams, "firstState">)
  | { type: "select_state_machine_state"; decision: StateMachineRunnerDecision };

export function createDefaultHarnessTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd);
}

export function createHarnessTools(input: {
  cwd: string;
  mode: HarnessMode;
  result: HarnessToolsResultRef;
}): AgentTool[] {
  const tools = createDefaultHarnessTools(input.cwd);
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(createStateMachineDefinitionTool(input.result));
  }

  tools.push(createSelectStateTool(input.result));
  return tools;
}

export function applyStateOverride(
  state: StateMachineState,
  override: StateMachineStateOverride | undefined,
): StateMachineState {
  if (!override || override.kind !== state.kind) {
    return state;
  }

  return { ...state, ...override.state } as StateMachineState;
}

function createStateMachineDefinitionTool(
  result: HarnessToolsResultRef,
): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description: "Create a state-machine definition for durable business-process work.",
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      result.current = {
        type: "create_state_machine_definition",
        definition: params.definition,
        firstState: params.firstState,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result.current, null, 2) }],
        details: result.current,
        terminate: true,
      };
    },
  };
}

function createSelectStateTool(result: HarnessToolsResultRef): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    label: "Select state machine state",
    description: "Select the next state-machine state, terminal state, or failure outcome.",
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const decision = normalizeRunnerDecision(params.decision);

      result.current = { type: "select_state_machine_state", decision };
      return {
        content: [{ type: "text", text: JSON.stringify(result.current, null, 2) }],
        details: result.current,
        terminate: true,
      };
    },
  };
}

function normalizeRunnerDecision(decision: ToolRunnerDecision): StateMachineRunnerDecision {
  if (decision.kind === "fail") {
    return {
      kind: "fail",
      reason: decision.reason ?? "No available state can make progress.",
    };
  }

  if (decision.kind === "terminal") {
    return {
      kind: "terminal",
      state: decision.state ?? "",
      reason: decision.reason,
    };
  }

  return {
    kind: "run_state",
    state: decision.state ?? "",
    reason: decision.reason,
    override: decision.override as StateMachineStateOverride | undefined,
  };
}
