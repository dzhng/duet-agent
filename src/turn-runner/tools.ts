import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCodingTools, type Skill } from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import dedent from "dedent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { TurnMode, TurnQuestion, TurnTodo } from "../types/protocol.js";
import type {
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineProgress,
  StateMachineScriptState,
  StateMachineState,
  StateMachineTerminalResult,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import { readSkillInstructions } from "./skills.js";

const jsonSchemaValidator = new Ajv({ strictSchema: false });

const questionOptionSchema = Type.Object({
  label: Type.String({ description: "Answer text shown to the user." }),
  description: Type.Optional(
    Type.String({ description: "Optional context explaining this choice." }),
  ),
});

const questionSchema = Type.Object({
  question: Type.String({ description: "Question to ask the user." }),
  header: Type.Optional(
    Type.String({ description: "Optional section heading for this question." }),
  ),
  options: Type.Array(questionOptionSchema, {
    description: "Answer options the user can choose from.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Whether the user may select more than one option." }),
  ),
});

const askUserQuestionSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    description: "Structured multiple-choice questions that must be answered before continuing.",
  }),
});

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;

const readSkillSchema = Type.Object({
  name: Type.String({
    description:
      "Skill name from the available skills metadata in the system prompt. Returns the full SKILL.md instructions (with shell expansions resolved).",
  }),
});

const todoStatusSchema = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ],
  {
    description:
      "pending = not started; in_progress = actively being worked on (keep at most one); completed = done; failed = could not finish, leave a note in content if useful.",
  },
);

const todoItemSchema = Type.Object({
  id: Type.String({
    description:
      "Stable unique identifier used to edit this todo in later calls. Pick something short and memorable so you can reuse it with merge=true to flip status.",
  }),
  content: Type.String({
    description:
      "Imperative description of the task, such as 'Run tests' or 'Update README model section'. One sentence; no narration.",
  }),
  status: todoStatusSchema,
});

const todoWriteSchema = Type.Object({
  merge: Type.Boolean({
    description:
      "false = replace the entire list (use this when you first plan the work). true = upsert by id (use this to flip a single todo's status without re-sending the rest).",
  }),
  todos: Type.Array(todoItemSchema, {
    description:
      "Todo items to write. With merge=false, pass the full desired list. With merge=true, pass only the items being added or updated.",
  }),
});

type TodoWriteParams = Static<typeof todoWriteSchema>;

export interface TodoWriteToolStorage {
  getTodos(): TurnTodo[];
  setTodos(todos: TurnTodo[]): void;
}

const agentOverrideSchema = Type.Partial(
  Type.Object({
    prompt: Type.String({ description: "Replacement user prompt for this agent state." }),
    systemPrompt: Type.String({
      description: "Replacement system prompt appended for this sub-agent only.",
    }),
    allowedSkills: Type.Array(Type.String(), {
      description:
        "Skill names to inject into this sub-agent. Omit to inject all available skills.",
    }),
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional.',
    }),
  }),
);

const scriptOverrideSchema = Type.Partial(
  Type.Object({
    command: Type.String({ description: "Replacement shell command for this script state." }),
    cwd: Type.String({ description: "Replacement working directory for the command." }),
    timeoutMs: Type.Number({ description: "Replacement command timeout in milliseconds." }),
    successCodes: Type.Array(Type.Number(), {
      description: "Replacement exit codes treated as successful completion.",
    }),
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional.',
    }),
  }),
);

const pollAttemptSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("script", { description: "Run one shell command per poll attempt." }),
    command: Type.String({
      description:
        "Shell command for one poll attempt. Return non-empty JSON only when polling found a result.",
    }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the poll command." })),
    successCodes: Type.Optional(
      Type.Array(Type.Number(), {
        description: "Exit codes that mean this poll attempt found a result.",
      }),
    ),
  }),
  Type.Object({
    kind: Type.Literal("timer", {
      description: "Sleep once for intervalMs, then resume with elapsedMs output.",
    }),
  }),
]);

const pollOverrideSchema = Type.Partial(
  Type.Object({
    intervalMs: Type.Number({ description: "Replacement delay between poll wake attempts." }),
    timeoutMs: Type.Number({ description: "Replacement maximum poll-state runtime." }),
    poll: pollAttemptSchema,
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "messageId": { "type": "string" } }, "required": ["messageId"] }. Fields omitted from required are optional.',
    }),
  }),
);

const stateOverrideSchema = Type.Union([
  Type.Object({ kind: Type.Literal("agent"), state: agentOverrideSchema }),
  Type.Object({ kind: Type.Literal("script"), state: scriptOverrideSchema }),
  Type.Object({ kind: Type.Literal("poll"), state: pollOverrideSchema }),
]);

const baseStateSchema = {
  name: Type.String({ description: "State name used by select_state_machine_state." }),
  when: Type.Optional(
    Type.String({ description: "Guidance for when the parent runner should select this state." }),
  ),
  inputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Valid JSON Schema object for the input the parent must pass when selecting this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional. Template strings read values from this object.',
    }),
  ),
};

const agentStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("agent", { description: "Run a sub-agent for this state." }),
  prompt: Type.String({
    description: "User prompt sent to the sub-agent. May use templates like {{ input.email }}.",
  }),
  systemPrompt: Type.Optional(
    Type.String({ description: "Optional system prompt appended for this sub-agent only." }),
  ),
  allowedSkills: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Skill names to inject into this sub-agent. Omit to inject all available skills.",
    }),
  ),
});

const scriptStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("script", { description: "Run a shell command for this state." }),
  command: Type.String({
    description: "Shell command to execute. May use templates like {{ input.email }}.",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the command." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Command timeout in milliseconds." })),
  successCodes: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Exit codes treated as successful completion. Defaults to [0].",
    }),
  ),
});

const pollStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("poll", { description: "Perform one external wait/check attempt." }),
  intervalMs: Type.Number({ description: "Delay before the next scheduled wake attempt." }),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Maximum time this state may remain polling." }),
  ),
  poll: pollAttemptSchema,
});

const terminalStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("terminal", { description: "Finalize the state-machine session." }),
  status: Type.Union([
    Type.Literal("completed", { description: "The state machine completed successfully." }),
    Type.Literal("failed", { description: "The state machine failed." }),
    Type.Literal("cancelled", { description: "The state machine was cancelled." }),
  ]),
  reason: Type.Optional(Type.String({ description: "Optional final explanation for the user." })),
});

const stateMachineStateSchema = Type.Union([
  agentStateSchema,
  scriptStateSchema,
  pollStateSchema,
  terminalStateSchema,
]);

export type StateMachineAgentStateOverride = Partial<
  Pick<StateMachineAgentState, "prompt" | "systemPrompt" | "allowedSkills" | "inputSchema">
>;

export type StateMachineScriptStateOverride = Partial<
  Pick<StateMachineScriptState, "command" | "cwd" | "timeoutMs" | "successCodes" | "inputSchema">
>;

export type StateMachinePollStateOverride = Partial<
  Pick<StateMachinePollState, "intervalMs" | "timeoutMs" | "poll" | "inputSchema">
>;

export type StateMachineStateOverride =
  | { kind: "agent"; state: StateMachineAgentStateOverride }
  | { kind: "script"; state: StateMachineScriptStateOverride }
  | { kind: "poll"; state: StateMachinePollStateOverride };

const stateMachineDefinitionSchema = Type.Object(
  {
    name: Type.String({ description: "Human-readable state-machine name." }),
    prompt: Type.String({
      description: "Routing guidance explaining when this state-machine definition applies.",
    }),
    states: Type.Array(stateMachineStateSchema, {
      description: "Available states the parent runner may select.",
    }),
  },
  {
    description:
      "State-machine definition. Use inputSchema plus {{ input.foo }} templates for state prompts and commands that need transition input.",
  },
);

const createDefinitionSchema = Type.Object({
  definition: stateMachineDefinitionSchema,
  firstState: Type.Optional(
    Type.String({ description: "Optional state name to run first after creating the definition." }),
  ),
});

type CreateDefinitionParams = Static<typeof createDefinitionSchema>;
type ToolStateMachineDefinition = CreateDefinitionParams["definition"];

const selectStateSchema = Type.Object({
  decision: Type.Object(
    {
      kind: Type.Union([Type.Literal("run_state"), Type.Literal("terminal"), Type.Literal("fail")]),
      state: Type.Optional(Type.String({ description: "State name to run or finalize." })),
      reason: Type.Optional(
        Type.String({ description: "Reason for a terminal or failure decision." }),
      ),
      override: Type.Optional(stateOverrideSchema),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Input object for the selected state. Required when the state inputSchema requires fields; templates read values as {{ input.field }}.",
        }),
      ),
    },
    {
      description:
        "State transition decision. Use input when selecting states with inputSchema or {{ input.foo }} templates.",
    },
  ),
});

type SelectStateParams = Static<typeof selectStateSchema>;
type ToolRunnerDecision = SelectStateParams["decision"];

export interface CurrentStateMachineStateResult {
  currentState?: string;
  currentInput?: Record<string, unknown>;
  terminal?: StateMachineTerminalResult;
  /** Compact per-state counters for obvious progress questions. */
  progress?: StateMachineProgress;
  /** Total state-machine history records; `history` below is only the recent tail. */
  historyCount: number;
  history: StateMachineSessionEvent[];
}

export type StateMachineRunnerDecision =
  | (ToolRunnerDecision & {
      kind: "run_state";
      state: string;
      override?: StateMachineStateOverride;
      input?: Record<string, unknown>;
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
  | { type: "select_state_machine_state"; decision: StateMachineRunnerDecision };

export function isTurnRunnerControlResult(value: unknown): value is TurnRunnerControlResult {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = value.type;
  return (
    type === "none" ||
    type === "ask_user_question" ||
    type === "create_state_machine_definition" ||
    type === "select_state_machine_state"
  );
}

interface TurnRunnerToolsInput {
  cwd: string;
  mode: TurnMode;
  todoStorage: TodoWriteToolStorage;
  getDefinition?: () => StateMachineDefinition | undefined;
  getStateMachine?: () => StateMachineSession | undefined;
  skills?: readonly Skill[];
}

export function createDefaultTurnRunnerTools(
  cwd: string,
  todoStorage: TodoWriteToolStorage,
  skills: readonly Skill[] = [],
): AgentTool[] {
  return [
    ...createCodingTools(cwd),
    createTodoWriteTool(todoStorage),
    createAskUserQuestionTool(),
    createReadSkillTool(skills),
  ];
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [...createDefaultTurnRunnerTools(input.cwd, input.todoStorage, input.skills)];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(createStateMachineDefinitionTool());
  }

  const getDefinition =
    typeof input.mode === "object"
      ? () => input.mode as StateMachineDefinition
      : input.getDefinition;
  tools.push(createSelectStateTool(getDefinition));
  tools.push(createCurrentStateMachineStateTool(input.getStateMachine));
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

function createReadSkillTool(skills: readonly Skill[]): AgentTool<typeof readSkillSchema> {
  return {
    name: "read_skill",
    label: "Read skill",
    description: dedent`
      Load the full SKILL.md instructions for one of the available skills listed in the system prompt.

      The system prompt only lists skill names and one-line descriptions to keep the context small. When a skill's description matches the task at hand, call this tool with its name to fetch the full instructions, then follow them.

      The response also includes the SKILL.md path so you can read sibling reference files (e.g. \`<dirname(path)>/reference/<file>\`) referenced by the instructions.
    `,
    parameters: readSkillSchema,
    async execute(_toolCallId, params) {
      const skill = skills.find((candidate) => candidate.name === params.name);
      if (!skill) {
        const available = skills.map((candidate) => candidate.name).join(", ") || "(none)";
        throw new Error(`Unknown skill: ${params.name}. Available skills: ${available}`);
      }

      const instructions = readSkillInstructions(skill);
      const header = dedent`
        Skill: ${skill.name}
        Path: ${skill.filePath}

        ---
      `;
      return {
        content: [{ type: "text", text: `${header}\n\n${instructions}` }],
        details: { type: "read_skill", name: skill.name, filePath: skill.filePath },
      };
    },
  };
}

export function createTodoWriteTool(
  storage: TodoWriteToolStorage,
): AgentTool<typeof todoWriteSchema> {
  return {
    name: "todo_write",
    label: "Write todos",
    description: dedent`
      Track multi-step work as a structured, visible todo list. The list is shown to the user in real time — it is your shared scratchpad of "what we agreed to do" and "where we are."

      Reach for this tool whenever any of these are true:
      - The user's message contains more than one independent task ("do X, also Y, and don't forget Z").
      - The work needs three or more non-trivial steps to finish (research, edit, test, commit, etc.).
      - You are about to spend several tool calls on something — write the plan first so the user can see and correct it.
      - You are resuming or interrupting work and want to make state explicit.

      How to use it well:
      - Lay out the full plan up front with merge=false. Mark exactly one item in_progress at a time.
      - As you finish each item, call again with merge=true and just that item flipped to completed; advance the next one to in_progress in the same call.
      - If the plan changes (user redirects, you discover new work), update the list immediately so it stays honest.
      - Skip the tool only for genuinely single-step requests — a one-shot answer or a single file edit doesn't need a list.

      Treat "the user gave me a list of asks" as an automatic cue to call this tool before doing anything else.
    `,
    parameters: todoWriteSchema,
    async execute(_toolCallId, params) {
      const todos = params.merge
        ? mergeTodos(storage.getTodos(), params.todos)
        : normalizeTodos(params.todos);
      storage.setTodos(todos);

      return {
        content: [{ type: "text", text: formatTodoWriteResult(todos) }],
        details: todos,
      };
    },
  };
}

function mergeTodos(existing: TurnTodo[], incoming: TodoWriteParams["todos"]): TurnTodo[] {
  const merged = existing.map((todo) => ({ ...todo }));
  const indexes = new Map(merged.map((todo, index) => [todo.id, index]));

  for (const todo of normalizeTodos(incoming)) {
    const index = indexes.get(todo.id);
    if (index === undefined) {
      indexes.set(todo.id, merged.length);
      merged.push(todo);
    } else {
      merged[index] = todo;
    }
  }

  return merged;
}

function normalizeTodos(todos: TodoWriteParams["todos"]): TurnTodo[] {
  return todos.map((todo) => ({ ...todo }));
}

function formatTodoWriteResult(todos: TurnTodo[]): string {
  if (todos.length === 0) return "Current task list is empty.";
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  return ["Current task list:", ...lines].join("\n");
}

function createStateMachineDefinitionTool(): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description:
      "Create a state-machine definition for durable business-process work. State prompts and script commands may use template strings such as {{ input.email }}; define inputSchema on those states and pass matching input when selecting them. Agent states may set allowedSkills to restrict which skills are injected into that sub-agent. Use this only when no state machine is active or the previous state machine has reached a terminal state; otherwise use select_state_machine_state.",
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      assertValidDefinitionInputSchemas(params.definition);
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
  getDefinition: (() => StateMachineDefinition | undefined) | undefined,
): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    label: "Select state machine state",
    description:
      "Select the next state-machine state, terminal state, or failure outcome. When the selected state has inputSchema or template strings like {{ input.email }}, pass the matching input object here.",
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const decision = normalizeRunnerDecision(params.decision);
      const definition = getDefinition?.();
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

function createCurrentStateMachineStateTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
): AgentTool {
  return {
    name: "get_current_state_machine_state",
    label: "Get current state-machine state",
    description:
      "Inspect current state-machine progress, including background work that ran after selecting a state. Use this after resume, interruption, or uncertainty before selecting the next state, and before answering user questions about state-machine progress, poll/wake status, what has already happened, or why the session is waiting.",
    parameters: Type.Object({}),
    async execute() {
      const stateMachine = getStateMachine?.();
      const result: CurrentStateMachineStateResult = {
        currentState: stateMachine?.currentState,
        currentInput: stateMachine?.currentInput,
        terminal: stateMachine?.terminal,
        progress: stateMachine?.progress,
        historyCount: stateMachine?.history.length ?? 0,
        history: stateMachine?.history.slice(-10) ?? [],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
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
  const selectedState = definition.states.find((state) => state.name === decision.state);
  if (!selectedState) {
    throw new Error(`Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`);
  }

  if (decision.kind !== "run_state") return;

  const effectiveState = applyStateOverride(selectedState, decision.override);
  assertValidStateInputSchema(effectiveState);
  assertValidStateInput(effectiveState, decision.input);
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
    input: decision.input,
  };
}

function assertValidStateInput(state: StateMachineState, input: unknown): void {
  if (!state.inputSchema) return;

  const candidate = input ?? {};
  if (Value.Check(state.inputSchema as never, candidate)) return;

  const errors = [...Value.Errors(state.inputSchema as never, candidate)];
  const first = errors[0] as { path?: string; message?: string } | undefined;
  const path = first?.path ?? "/";
  const message = first?.message ?? "does not match schema";
  throw new Error(`Invalid input for state "${state.name}" at ${path}: ${message}`);
}

function assertValidDefinitionInputSchemas(definition: StateMachineDefinition): void {
  for (const state of definition.states) {
    if (state.name === INTERRUPTED_STATE_MACHINE_STATE) {
      throw new Error(`State name "${INTERRUPTED_STATE_MACHINE_STATE}" is reserved.`);
    }
    assertValidStateInputSchema(state);
  }
}

function assertValidStateInputSchema(state: StateMachineState): void {
  if (!state.inputSchema) return;

  if (jsonSchemaValidator.validateSchema(state.inputSchema)) return;

  const message = jsonSchemaValidator.errorsText(jsonSchemaValidator.errors, {
    dataVar: `inputSchema for state "${state.name}"`,
  });
  throw new Error(`Invalid inputSchema for state "${state.name}": ${message}`);
}
