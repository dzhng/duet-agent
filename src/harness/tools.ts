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

const harnessTurnOptionsSchema = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("auto"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
  ),
});

const agentOverrideSchema = Type.Partial(
  Type.Object({
    prompt: Type.String(),
    contextScope: Type.Union([
      Type.Literal("state"),
      Type.Literal("dependencies"),
      Type.Literal("state_machine"),
    ]),
    allowedSkills: Type.Array(Type.String()),
    options: harnessTurnOptionsSchema,
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
  options: Type.Optional(harnessTurnOptionsSchema),
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

export interface HarnessToolsResultRef {
  current: HarnessControlResult;
}

export interface HarnessToolSet {
  tools: AgentTool[];
  result: HarnessToolsResultRef;
}

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
  const tools = [...createDefaultHarnessTools(input.cwd)];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(createStateMachineDefinitionTool(input.result));
  }

  tools.push(createSelectStateTool(input.result));
  return tools;
}

export function createHarnessToolSet(input: { cwd: string; mode: HarnessMode }): HarnessToolSet {
  const result: HarnessToolsResultRef = { current: { type: "none" } };
  return {
    result,
    tools: createHarnessTools({ ...input, result }),
  };
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
