import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { TurnMode, TurnQuestion } from "../types/protocol.js";
import type {
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineScriptState,
  StateMachineState,
} from "../types/state-machine.js";

const questionOptionSchema = Type.Object({
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const questionSchema = Type.Object({
  question: Type.String(),
  header: Type.Optional(Type.String()),
  options: Type.Array(questionOptionSchema),
  multiSelect: Type.Optional(Type.Boolean()),
});

const askUserQuestionSchema = Type.Object({
  questions: Type.Array(questionSchema),
});

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;

const agentOverrideSchema = Type.Partial(
  Type.Object({
    prompt: Type.String(),
    contextScope: Type.Union([
      Type.Literal("state"),
      Type.Literal("dependencies"),
      Type.Literal("state_machine"),
    ]),
    allowedSkills: Type.Array(Type.String()),
    maxTurns: Type.Number(),
    outputSchema: Type.Record(Type.String(), Type.Any()),
  }),
);

const scriptOverrideSchema = Type.Partial(
  Type.Object({
    command: Type.String(),
    cwd: Type.String(),
    timeoutMs: Type.Number(),
    successCodes: Type.Array(Type.Number()),
  }),
);

const pollAttemptSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("script"),
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    successCodes: Type.Optional(Type.Array(Type.Number())),
  }),
  Type.Object({
    kind: Type.Literal("prompt"),
    prompt: Type.String(),
    outputSchema: Type.Optional(Type.Record(Type.String(), Type.Any())),
  }),
]);

const pollOverrideSchema = Type.Partial(
  Type.Object({
    intervalMs: Type.Number(),
    timeoutMs: Type.Number(),
    poll: pollAttemptSchema,
  }),
);

const stateOverrideSchema = Type.Union([
  Type.Object({ kind: Type.Literal("agent"), state: agentOverrideSchema }),
  Type.Object({ kind: Type.Literal("script"), state: scriptOverrideSchema }),
  Type.Object({ kind: Type.Literal("poll"), state: pollOverrideSchema }),
]);

const baseStateSchema = {
  name: Type.String(),
  when: Type.Optional(Type.String()),
};

const agentStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("agent"),
  prompt: Type.String(),
  contextScope: Type.Optional(
    Type.Union([
      Type.Literal("state"),
      Type.Literal("dependencies"),
      Type.Literal("state_machine"),
    ]),
  ),
  allowedSkills: Type.Optional(Type.Array(Type.String())),
  maxTurns: Type.Optional(Type.Number()),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const scriptStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("script"),
  command: Type.String(),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  successCodes: Type.Optional(Type.Array(Type.Number())),
});

const pollStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("poll"),
  intervalMs: Type.Number(),
  timeoutMs: Type.Optional(Type.Number()),
  poll: pollAttemptSchema,
});

const terminalStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("terminal"),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  reason: Type.Optional(Type.String()),
});

const stateMachineStateSchema = Type.Union([
  agentStateSchema,
  scriptStateSchema,
  pollStateSchema,
  terminalStateSchema,
]);

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

const stateMachineDefinitionSchema = Type.Object({
  name: Type.String(),
  prompt: Type.String(),
  states: Type.Array(stateMachineStateSchema),
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
    override: Type.Optional(stateOverrideSchema),
  }),
});

type SelectStateParams = Static<typeof selectStateSchema>;
type ToolRunnerDecision = SelectStateParams["decision"];

const promptStateMachineAgentSchema = Type.Object({
  prompt: Type.String(),
});

type PromptStateMachineAgentParams = Static<typeof promptStateMachineAgentSchema>;

export type StateMachineRunnerDecision =
  | (ToolRunnerDecision & {
      kind: "run_state";
      state: string;
      override?: StateMachineStateOverride;
    })
  | (ToolRunnerDecision & { kind: "terminal"; state: string })
  | (ToolRunnerDecision & { kind: "fail"; reason: string });

export type TurnRunnerControlResult =
  | { type: "none" }
  | ({
      type: "ask_user_question";
      questions: TurnQuestion[];
    } & AskUserQuestionParams)
  | ({
      type: "create_state_machine_definition";
      definition: ToolStateMachineDefinition;
    } & Pick<CreateDefinitionParams, "firstState">)
  | { type: "select_state_machine_state"; decision: StateMachineRunnerDecision }
  | ({
      type: "prompt_state_machine_agent";
    } & PromptStateMachineAgentParams);

interface TurnRunnerToolsInput {
  cwd: string;
  mode: TurnMode;
  definition?: StateMachineDefinition;
}

export function createDefaultTurnRunnerTools(cwd: string): AgentTool[] {
  return [...createCodingTools(cwd), createAskUserQuestionTool()];
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [...createDefaultTurnRunnerTools(input.cwd)];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(createStateMachineDefinitionTool());
  }

  const definition = typeof input.mode === "object" ? input.mode : input.definition;
  tools.push(createSelectStateTool(definition));
  tools.push(createPromptStateMachineAgentTool());
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

function createAskUserQuestionTool(): AgentTool<typeof askUserQuestionSchema> {
  return {
    name: "ask_user_question",
    label: "Ask user question",
    description:
      "Ask the user one or more structured multiple-choice questions. Use this when progress requires user input before continuing.",
    parameters: askUserQuestionSchema,
    async execute(_toolCallId, params) {
      const result: TurnRunnerControlResult = {
        type: "ask_user_question",
        questions: params.questions,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

function createStateMachineDefinitionTool(): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description:
      "Create a state-machine definition for durable business-process work. Use this only when no state machine is active or the previous state machine has reached a terminal state; otherwise use select_state_machine_state.",
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      const result: TurnRunnerControlResult = {
        type: "create_state_machine_definition",
        definition: params.definition,
        firstState: params.firstState,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

function createSelectStateTool(
  definition: StateMachineDefinition | undefined,
): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    label: "Select state machine state",
    description: "Select the next state-machine state, terminal state, or failure outcome.",
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const decision = normalizeRunnerDecision(params.decision);
      assertValidSelectedState(decision, definition);

      const result: TurnRunnerControlResult = { type: "select_state_machine_state", decision };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

function createPromptStateMachineAgentTool(): AgentTool<typeof promptStateMachineAgentSchema> {
  return {
    name: "prompt_state_machine_agent",
    label: "Prompt state-machine agent",
    description:
      "Send a prompt to the current state-machine agent state instead of selecting a new state. Use this when the current state is an agent state that needs user context or a direct answer before the state machine can continue.",
    parameters: promptStateMachineAgentSchema,
    async execute(_toolCallId, params) {
      const result: TurnRunnerControlResult = {
        type: "prompt_state_machine_agent",
        prompt: params.prompt,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

function assertValidSelectedState(
  decision: StateMachineRunnerDecision,
  definition: StateMachineDefinition | undefined,
): void {
  if (decision.kind === "fail" || !definition) {
    return;
  }

  const validStates = definition.states.map((state) => state.name);
  if (!validStates.includes(decision.state)) {
    throw new Error(`Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`);
  }
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
