import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type BashOperations,
  createCodingTools,
  createLocalBashOperations,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import dedent from "dedent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { toXML } from "../lib/xml.js";
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
  StateMachineTimerState,
  StateMachineTerminalResult,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import { generateStructuredOutput } from "../core/structured-output.js";
import type { EmbedFn } from "../memory/embedding.js";
import { recallMemory, reciprocalRankFusion, type RecallScope } from "../memory/recall.js";
import type { Observation } from "../types/memory.js";
import type { MemorySession } from "../memory/session.js";
import type { ActiveStateOutput } from "./state-machine-controller.js";
import { readSkillInstructions } from "./skills.js";
import { withBundledRipgrep } from "./bundled-ripgrep.js";

const jsonSchemaValidator = new Ajv({ strictSchema: false });

/**
 * Default cap (in seconds) applied to bash tool invocations that omit an
 * explicit timeout. Upstream's bash tool ships with no default timeout, so
 * stray commands like `find /` could otherwise run for many minutes before
 * anything intervenes. The model can still pass a larger `timeout` argument
 * for legitimate long-running work.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

/**
 * Wrap a `BashOperations` implementation so any `exec` call without an
 * explicit `timeout` uses `defaultTimeoutSeconds`. Calls that already specify
 * a timeout (the model passed one) are forwarded unchanged.
 */
export function withDefaultBashTimeout(
  base: BashOperations,
  defaultTimeoutSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): BashOperations {
  return {
    exec: (command, cwd, options) =>
      base.exec(command, cwd, {
        ...options,
        timeout: options.timeout ?? defaultTimeoutSeconds,
      }),
  };
}

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
    minItems: 1,
    description:
      "Answer options the user can choose from. Each question must have at least one option so the user has something to select.",
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
    cwd: Type.String({
      description:
        "Replacement working directory for this sub-agent's coding tools (bash, read, write, edit).",
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

const pollOverrideSchema = Type.Partial(
  Type.Object({
    intervalMs: Type.Number({
      description: "Replacement recurring delay between poll wake attempts.",
    }),
    timeoutMs: Type.Number({ description: "Replacement maximum poll-state runtime." }),
    command: Type.String({
      description: "Replacement shell command for one poll attempt.",
    }),
    cwd: Type.String({ description: "Replacement working directory for the poll command." }),
    successCodes: Type.Array(Type.Number(), {
      description: "Replacement exit codes that mean this poll attempt found a result.",
    }),
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "messageId": { "type": "string" } }, "required": ["messageId"] }. Fields omitted from required are optional.',
    }),
  }),
);

const timerOverrideSchema = Type.Partial(
  Type.Object({
    wakeAt: Type.Number({
      description: "Replacement absolute Unix epoch millisecond time for this timer state.",
    }),
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "scheduledAt": { "type": "number" } }, "required": ["scheduledAt"] }. Fields omitted from required are optional.',
    }),
  }),
);

const stateOverrideSchema = Type.Union([
  Type.Object({ kind: Type.Literal("agent"), state: agentOverrideSchema }),
  Type.Object({ kind: Type.Literal("script"), state: scriptOverrideSchema }),
  Type.Object({ kind: Type.Literal("poll"), state: pollOverrideSchema }),
  Type.Object({ kind: Type.Literal("timer"), state: timerOverrideSchema }),
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
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for this sub-agent's coding tools. Defaults to the state-machine session cwd.",
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
  intervalMs: Type.Number({
    description: "Recurring delay before the next scheduled poll attempt.",
  }),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Maximum time this state may remain polling." }),
  ),
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
});

const timerStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("timer", {
    description:
      "Sleep until one absolute Unix epoch millisecond time, then resume with elapsedMs and timestamp output.",
  }),
  wakeAt: Type.Number({
    description: "Absolute Unix epoch millisecond time when this timer state should complete.",
  }),
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
  timerStateSchema,
  terminalStateSchema,
]);

export type StateMachineAgentStateOverride = Partial<
  Pick<StateMachineAgentState, "prompt" | "systemPrompt" | "allowedSkills" | "cwd" | "inputSchema">
>;

export type StateMachineScriptStateOverride = Partial<
  Pick<StateMachineScriptState, "command" | "cwd" | "timeoutMs" | "successCodes" | "inputSchema">
>;

export type StateMachinePollStateOverride = Partial<
  Pick<
    StateMachinePollState,
    "intervalMs" | "timeoutMs" | "command" | "cwd" | "successCodes" | "inputSchema"
  >
>;
export type StateMachineTimerStateOverride = Partial<
  Pick<StateMachineTimerState, "wakeAt" | "inputSchema">
>;

export type StateMachineStateOverride =
  | { kind: "agent"; state: StateMachineAgentStateOverride }
  | { kind: "script"; state: StateMachineScriptStateOverride }
  | { kind: "poll"; state: StateMachinePollStateOverride }
  | { kind: "timer"; state: StateMachineTimerStateOverride };

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
      state: Type.String({
        description:
          "Name of the state to advance to. Must exactly match one of the names declared in the active definition (including the auto-injected `failed` and `cancelled` terminal escape hatches). Selecting a terminal state ends the state machine.",
      }),
      reason: Type.Optional(
        Type.String({
          description:
            "Free-form explanation attached to the resulting terminal when `state` names a terminal state. Ignored for non-terminal states.",
        }),
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
        "State transition decision. Use `input` when selecting states with inputSchema or {{ input.foo }} templates; `reason` carries through to terminal states.",
    },
  ),
});

export interface CurrentStateMachineStateResult {
  currentState?: string;
  currentInput?: Record<string, unknown>;
  terminal?: StateMachineTerminalResult;
  /** Compact per-state counters for obvious progress questions. */
  progress?: StateMachineProgress;
  /** Total state-machine history records; `history` below is only the recent tail. */
  historyCount: number;
  /** Transient output from the currently running state, if one is active. */
  activeOutput?: ActiveStateOutput;
  history: StateMachineSessionEvent[];
}

// A runner decision is simply "go to this state, optionally with these
// transition extras". The state's own `kind` (agent/script/poll/timer/terminal)
// in the definition drives dispatch; the decision does not need to restate it.
// To end the machine in failure, select the auto-injected `failed` terminal
// (and optionally attach a `reason`) — there is no separate fail verb.
export interface StateMachineRunnerDecision {
  state: string;
  reason?: string;
  override?: StateMachineStateOverride;
  input?: Record<string, unknown>;
}

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
  getActiveStateOutput?: () => ActiveStateOutput | undefined;
  skills?: readonly Skill[];
  recallStorage?: RecallMemoryToolStorage;
}

export interface RecallMemoryToolStorage {
  /**
   * Returns the memory session backing the runner's durable memory, or
   * undefined when memory persistence is disabled (one-shot tools, tests).
   * The recall_memory tool no-ops when undefined so the model never sees a
   * tool whose backing store is missing. The session is fetched per call
   * so recall sees the runner's current persistence handle even after a
   * lazy load completes mid-session.
   */
  getSession: () => MemorySession | undefined;
  /**
   * Embedding callable. Optional: when undefined or when calls fail,
   * recall falls back to keyword-only retrieval. Built once per runner
   * by the embedding client so connection reuse amortizes TLS setup.
   */
  embed?: EmbedFn;
  /** Current session id for scope filtering. */
  sessionId?: string;
  /**
   * Model used by the optional `expand` flag to generate paraphrases.
   * Resolved by the runner so query expansion shares the same memory
   * model as the observer/reflector — typically a cheap model like
   * Haiku or Gemini Flash.
   */
  expansionModel?: string;
}

export function createDefaultTurnRunnerTools(
  cwd: string,
  todoStorage: TodoWriteToolStorage,
  skills: readonly Skill[] = [],
  recallStorage?: RecallMemoryToolStorage,
): AgentTool[] {
  const tools: AgentTool[] = [
    ...createCodingTools(cwd, {
      bash: {
        operations: withBundledRipgrep(withDefaultBashTimeout(createLocalBashOperations())),
      },
    }),
    createTodoWriteTool(todoStorage),
    createAskUserQuestionTool(),
    createReadSkillTool(skills),
  ];
  if (recallStorage) {
    tools.push(createRecallMemoryTool(recallStorage));
  }
  return tools;
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [
    ...createDefaultTurnRunnerTools(
      input.cwd,
      input.todoStorage,
      input.skills,
      input.recallStorage,
    ),
  ];
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
  tools.push(createCurrentStateMachineStateTool(input.getStateMachine, input.getActiveStateOutput));
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
      // The schema declares minItems: 1 on options, but defend at runtime too:
      // some providers will still emit an empty options array, which would
      // leave the user with no answers to pick and stall the turn.
      const emptyIndex = params.questions.findIndex((question) => question.options.length === 0);
      if (emptyIndex !== -1) {
        throw new Error(
          `ask_user_question rejected: questions[${emptyIndex}] has no options. Each question must include at least one option.`,
        );
      }
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

const recallMemorySchema = Type.Object({
  query: Type.String({
    description:
      "Free-text description of what to recall. Use proper nouns, code symbols, or short paraphrases of the user's prior statements; the search is hybrid (vector + keyword), so both fuzzy and exact matches work.",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum results to return. Default 8.",
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("session"), Type.Literal("global"), Type.Literal("all")], {
      description:
        "'session' restricts to the current conversation, 'global' to every other session, 'all' (default) searches both.",
    }),
  ),
  expand: Type.Optional(
    Type.Boolean({
      description:
        "When true, the agent runs the original query plus two paraphrased variants and fuses the result sets. Useful when the first call returned weak results; off by default to keep latency low.",
    }),
  ),
});

function createRecallMemoryTool(
  storage: RecallMemoryToolStorage,
): AgentTool<typeof recallMemorySchema> {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description: dedent`
      Search the user's durable memory for facts, decisions, and prior context from past conversations.

      Hybrid retrieval (vector embeddings + keyword) ranks results by reciprocal rank fusion. Use \`scope: "global"\` to look only at other sessions, \`"session"\` for the current one, or \`"all"\` (default) when unsure. Pass \`expand: true\` to run paraphrased variants alongside the original query when a first pass returned weak results.
    `,
    parameters: recallMemorySchema,
    async execute(_toolCallId, params) {
      const session = storage.getSession();
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "Memory persistence is disabled for this session, so there is nothing to recall.",
            },
          ],
          details: { type: "recall_memory", disabled: true },
        };
      }
      const scope: RecallScope = params.scope ?? "all";
      const limit = params.limit ?? 8;

      const queries: string[] = [params.query];
      if (params.expand && storage.expansionModel) {
        // Paraphrases broaden recall on vague queries by giving the
        // hybrid pipeline two more shots at matching the user's intent.
        // Ranks fuse across all three runs so a row that scores well
        // on any phrasing rises to the top.
        const paraphrases = await generateQueryParaphrases(params.query, storage.expansionModel);
        queries.push(...paraphrases);
      }

      const runs = await Promise.all(
        queries.map((query) =>
          recallMemory({
            session,
            embed: storage.embed,
            query,
            // Over-fetch per run so the post-fusion top-K is drawn from
            // a richer candidate pool when expand is on.
            limit: params.expand ? limit * 2 : limit,
            scope,
            sessionId: storage.sessionId,
          }),
        ),
      );

      const fusedIds = reciprocalRankFusion(
        runs.map((run) =>
          run.observations.map((observation, rank) => ({ id: observation.id, rank })),
        ),
      ).slice(0, limit);
      const byId = new Map(
        runs.flatMap((run) => run.observations).map((observation) => [observation.id, observation]),
      );
      const observations = fusedIds
        .map((id) => byId.get(id))
        .filter((observation): observation is Observation => observation !== undefined);

      const vectorAttempted = runs.some((run) => run.vectorSearchAttempted);
      const vectorSucceeded = runs.some((run) => run.vectorSearchSucceeded);
      const summary = observations.length
        ? observations.map(formatRecallHit).join("\n\n")
        : "(no matches)";
      const header =
        vectorAttempted && !vectorSucceeded
          ? "# Memory recall (keyword-only fallback; semantic search unavailable)"
          : "# Memory recall";

      return {
        content: [{ type: "text", text: `${header}\n\n${summary}` }],
        details: {
          type: "recall_memory",
          query: params.query,
          scope,
          expanded: queries.length > 1,
          hits: observations.length,
          vectorSearchSucceeded: vectorSucceeded,
        },
      };
    },
  };
}

const paraphraseSchema = Type.Object({
  paraphrases: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
});

async function generateQueryParaphrases(query: string, model: string): Promise<string[]> {
  // Two paraphrases is the sweet spot in the gbrain ablation: enough
  // breadth to catch reworded queries, few enough that latency stays
  // under ~300ms with cheap models. Returning the original on failure
  // keeps recall_memory itself robust even when expansion misbehaves.
  try {
    const result = await generateStructuredOutput({
      model,
      tool: {
        name: "emit_paraphrases",
        description: "Return alternate phrasings of the user's query.",
        parameters: paraphraseSchema,
      },
      systemPrompt:
        "You rewrite a memory-recall query into 2 alternative phrasings. Keep the same intent; vary terminology. Do not answer the query.",
      prompt: `Original query: ${query}`,
    });
    return result.paraphrases.slice(0, 2);
  } catch {
    return [];
  }
}

function formatRecallHit(observation: Observation): string {
  // Mirror the rendering used in the static memory section so the
  // model sees one consistent shape across the prompt prefix and the
  // tool's tool-result payload.
  const time = observation.timeOfDay ? ` ${observation.timeOfDay}` : "";
  const referenced = observation.referencedDate ? ` [ref: ${observation.referencedDate}]` : "";
  const session = observation.sessionId ? ` (session ${observation.sessionId})` : "";
  const priority =
    observation.priority === "high" ? "HIGH" : observation.priority === "medium" ? "MED" : "LOW";
  return `- ${priority} ${observation.kind} ${observation.observedDate}${time}${referenced}${session}\n  ${observation.content}`;
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
      Track multi-step work that you are doing yourself in this conversation, as a structured, visible todo list. The list is shown to the user in real time — it is your shared scratchpad of "what we agreed to do" and "where we are."

      Reach for this tool when the steps require *your* ongoing reasoning and tool use in this transcript: edits you need to review, search results you need to keep referencing, or work where the user wants to see your moves as you make them. Use it whenever any of these are true:
      - The user's message contains more than one independent task ("do X, also Y, and don't forget Z") and you will handle them yourself.
      - The work needs three or more non-trivial steps to finish (research, edit, test, commit, etc.) that you will execute in this conversation.
      - You are about to spend several tool calls on something — write the plan first so the user can see and correct it.
      - You are resuming or interrupting work and want to make state explicit.

      Prefer a state machine over this tool when the steps are well-scoped enough that a sub-agent or script could complete each one on its own ("do X with these inputs and return the result"). State-machine states run outside this transcript, so their intermediate output does not consume your context — using todo_write for that kind of work pollutes the parent context with tool output you do not actually need to keep.

      Hard cutoff: if the plan would have roughly seven or more items, or any item is itself a multi-step job (a whole refactor phase, a whole test file, a whole module extraction), do not use todo_write — use create_state_machine_definition with one agent state per item. Agent states have no minimum duration; only poll intervalMs and timer wakeAt have the 15-minute floor. If you can already see the work will not fit in one session and you are tempted to recommend the user "continue in the next session," that is the signal that this tool was the wrong choice and a state machine was the right one.

      How to use it well:
      - Lay out the full plan up front with merge=false. Mark exactly one item in_progress at a time.
      - As you finish each item, call again with merge=true and just that item flipped to completed; advance the next one to in_progress in the same call.
      - If the plan changes (user redirects, you discover new work), update the list immediately so it stays honest.
      - Skip the tool for genuinely single-step requests — a one-shot answer or a single file edit doesn't need a list.

      Treat "the user gave me a list of asks I will handle myself" as an automatic cue to call this tool before doing anything else.
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
  const body = ["Current task list:", ...lines].join("\n");
  const hasOpenTodos = todos.some(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (!hasOpenTodos) return body;
  const reminder = dedent`
    <system-reminder>
    The todo list still has unfinished items. As you complete each one, call todo_write again with merge=true to flip its status to completed (and advance the next item to in_progress). Keep calling todo_write until every item is in a terminal state.
    </system-reminder>
  `;
  return `${body}\n\n${reminder}`;
}

/**
 * Build the prompt body delivered to the parent on its acknowledgment
 * turn — the extra parent prompt run by the turn runner after every
 * state-machine terminal so the parent gets to react in natural
 * language (or take a follow-up control action).
 *
 * The framing is deliberately neutral on "decided vs runtime failure":
 * the parent's own transcript already shows whether it selected the
 * terminal (its preceding `select_state_machine_state` tool call) or
 * whether the state machine ended on its own, and the terminal
 * `status`/`reason` carry the rest of what the parent needs to phrase
 * the reply. The prompt only has to steer the parent away from
 * `select_state_machine_state` (the state machine has already ended)
 * and toward either plain-text reply or
 * `create_state_machine_definition` for follow-up work.
 */
export function formatStateMachineTerminalAcknowledgmentPrompt(input: {
  session: StateMachineSession;
}): string {
  const { session } = input;
  const terminal = session.terminal;
  if (!terminal) {
    throw new Error("formatStateMachineTerminalAcknowledgmentPrompt requires a terminal session.");
  }
  return dedent`
    The state machine "${session.definition.name}" has reached a terminal state and is no longer running.

    ${toXML({
      state_machine_terminal: {
        state: terminal.state,
        status: terminal.status,
        reason: terminal.reason ?? null,
      },
    })}

    Respond now:
    - If you want to start follow-up work (retry, remediation, next business process), call create_state_machine_definition.
    - Otherwise reply to the user in plain text summarizing what happened and what you recommend next.

    Do not call select_state_machine_state — there is no active state machine to advance.
  `;
}

export function formatCarriedTodosReminder(todos: TurnTodo[] | undefined): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const openTodos = todos.filter(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (openTodos.length === 0) return undefined;
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  return dedent`
    <system-reminder>
    You have an existing todo list from earlier in this conversation:
    ${lines.join("\n")}
    This list is shown to the user, so it must accurately reflect what you are actually working on right now. Update it with todo_write (merge=true) as you make progress, and keep calling todo_write until every item is in a terminal state. If the list is no longer relevant to the current request, call todo_write with merge=false and an empty todos array to clear it.
    </system-reminder>
  `;
}

function createStateMachineDefinitionTool(): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description: dedent`
      Create a new state-machine definition for durable, multi-step, or recurring work. See the system prompt for full routing rules (when to choose this over todo_write, how states resume, terminal acknowledgment, etc.). This description only covers the call shape.

      Call shape (top-level keys are \`definition\` and \`firstState\` ONLY — every state goes inside \`definition.states\`, never at the top level):
      {
        "definition": {
          "name": "<human-readable state-machine name>",
          "prompt": "<routing guidance for when this state machine applies>",
          "states": [
            { "name": "step-1", "kind": "agent", "prompt": "..." },
            { "name": "step-2", "kind": "script", "command": "..." },
            { "name": "done", "kind": "terminal", "status": "completed" }
          ]
        },
        "firstState": "step-1"
      }

      State \`kind\` is one of \`agent\`, \`script\`, \`poll\`, \`timer\`, \`terminal\`. Poll \`intervalMs\` and timer \`wakeAt\` must be ≥ 15 minutes; agent/script states have no minimum duration. Every definition needs at least one \`terminal\` state with status "completed"; "failed" and "cancelled" terminals are auto-injected if omitted.

      State prompts and script commands may use \`{{ input.foo }}\` templates — declare \`inputSchema\` on those states and pass matching \`input\` when selecting them via select_state_machine_state. Agent states may set \`allowedSkills\` to restrict the skill set for that sub-agent.

      Only use this when no state machine is active or the previous one has reached a terminal state; otherwise call select_state_machine_state.
    `,
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      assertValidDefinition(params.definition);
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
    description: dedent`
      Select the next state-machine state. \`decision.state\` must exactly match one of the state names declared in the active definition; the named state's own kind in the definition (agent, script, poll, timer, or terminal) drives what runs. When the selected state has inputSchema or template strings like {{ input.email }}, pass the matching input object here. Poll overrides must keep intervalMs set; timer overrides may replace wakeAt.

      Carry forward what the orchestrator now knows. Each agent state runs in a fresh sub-agent context with no view of the previous state's transcript, tool output, or output value — it only sees the rendered prompt and the input you pass here. So when a previous state surfaced facts the next state will need (file paths, IDs, error messages, decisions, summaries, root causes), either pass them as \`input\` (when the state's inputSchema has matching fields) or use \`override.prompt\` to inline the findings into the next state's prompt before running it. A static prompt that says "using the findings from the previous step" without inputs or an override is a bug: the sub-agent has no way to read those findings.

      Selecting a terminal state ends the state machine. Every definition is guaranteed to have the auto-injected \`failed\` and \`cancelled\` terminals available, so to fail or cancel, just select one of those by name and optionally attach a \`reason\`. After a terminal you will be woken once more for an acknowledgment turn — the runner re-prompts you with the terminal details (state, status, reason) so you can reply to the user in plain text and, if appropriate, kick off a follow-up state machine via create_state_machine_definition. Do not call select_state_machine_state on that acknowledgment turn; the state machine is already terminal.
    `,
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const definition = getDefinition?.();
      const decision: StateMachineRunnerDecision = {
        state: params.decision.state,
        reason: params.decision.reason,
        override: params.decision.override as StateMachineStateOverride | undefined,
        input: params.decision.input,
      };
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
  getActiveStateOutput: (() => ActiveStateOutput | undefined) | undefined,
): AgentTool {
  return {
    name: "get_current_state_machine_state",
    label: "Get current state-machine state",
    description:
      "Inspect current state-machine progress, including background work that ran after selecting a state. Use this after resume, interruption, or uncertainty before selecting the next state, and before answering user questions about state-machine progress, poll/wake status, what has already happened, or why the session is waiting.",
    parameters: Type.Object({}),
    async execute() {
      const stateMachine = getStateMachine?.();
      const activeOutput = getActiveStateOutput?.();
      const result: CurrentStateMachineStateResult = {
        currentState: stateMachine?.currentState,
        currentInput: stateMachine?.currentInput,
        terminal: stateMachine?.terminal,
        progress: stateMachine?.progress,
        historyCount: stateMachine?.history.length ?? 0,
        history: stateMachine?.history.slice(-10) ?? [],
      };
      if (activeOutput) {
        result.activeOutput = activeOutput;
      }
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
  if (!definition) return;

  const validStates = definition.states.map((state) => state.name);
  const selectedState = definition.states.find((state) => state.name === decision.state);
  if (!selectedState) {
    throw new Error(`Unknown state: ${decision.state}. Valid states: ${validStates.join(", ")}`);
  }

  // Terminal states don't accept override or per-transition input — they
  // just record their status and reason. Skip the override/input checks so
  // a caller selecting `failed` (or any other terminal) with an empty
  // decision is always accepted.
  if (selectedState.kind === "terminal") return;

  const effectiveState = applyStateOverride(selectedState, decision.override);
  assertValidStateInputSchema(effectiveState);
  assertValidStateSchedule(effectiveState);
  assertValidStateInput(effectiveState, decision.input);
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

// Minimum poll/timer cadence. State machines are for long-running lifecycle
// work that survives sleeps, wakes, and background execution; anything shorter
// than this should be performed directly in the parent turn rather than paid
// for with the orchestration overhead of a state machine.
const MINIMUM_STATE_MACHINE_DELAY_MS = 15 * 60 * 1000;

function assertValidDefinition(definition: StateMachineDefinition): void {
  for (const state of definition.states) {
    if (state.name === INTERRUPTED_STATE_MACHINE_STATE) {
      throw new Error(`State name "${INTERRUPTED_STATE_MACHINE_STATE}" is reserved.`);
    }
    assertValidStateInputSchema(state);
    assertValidStateSchedule(state);
    assertValidStateScheduleMinimum(state);
  }
  injectMissingTerminalEscapeHatches(definition);
  assertHasCompletedTerminal(definition);
}

// The author defines the happy-path exit; failed/cancelled escape hatches are
// added automatically so every definition can always be aborted or finalized
// without forcing the caller to remember boilerplate terminal states.
function injectMissingTerminalEscapeHatches(definition: StateMachineDefinition): void {
  const existingNames = new Set(definition.states.map((state) => state.name));
  if (!existingNames.has("failed")) {
    definition.states.push({ kind: "terminal", name: "failed", status: "failed" });
  }
  if (!existingNames.has("cancelled")) {
    definition.states.push({ kind: "terminal", name: "cancelled", status: "cancelled" });
  }
}

function assertHasCompletedTerminal(definition: StateMachineDefinition): void {
  const hasCompletedTerminal = definition.states.some(
    (state) => state.kind === "terminal" && state.status === "completed",
  );
  if (!hasCompletedTerminal) {
    throw new Error(
      'State-machine definition must include at least one terminal state with status "completed" representing successful completion of the lifecycle.',
    );
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

// Shape validation: intervalMs / wakeAt must be present and finite. Runs at
// both definition creation and state selection so malformed overrides are
// rejected too.
function assertValidStateSchedule(state: StateMachineState): void {
  if (
    state.kind === "poll" &&
    (typeof state.intervalMs !== "number" ||
      !Number.isFinite(state.intervalMs) ||
      state.intervalMs <= 0)
  ) {
    throw new Error(
      `Invalid poll schedule for state "${state.name}": intervalMs must be positive.`,
    );
  }
  if (
    state.kind === "timer" &&
    (typeof state.wakeAt !== "number" || !Number.isFinite(state.wakeAt))
  ) {
    throw new Error(`Invalid timer schedule for state "${state.name}": wakeAt must be finite.`);
  }
}

// Minimum-cadence guidance: enforced only when a new definition is being
// created. Existing definitions handed to the runner via `mode:` may legitimately
// have shorter cadences from configuration the agent did not author, and the
// runtime should run them as-is rather than re-litigating the boundary.
function assertValidStateScheduleMinimum(state: StateMachineState): void {
  if (state.kind === "poll" && typeof state.intervalMs === "number") {
    if (state.intervalMs < MINIMUM_STATE_MACHINE_DELAY_MS) {
      throw new Error(
        `Invalid poll schedule for state "${state.name}": intervalMs must be at least 15 minutes (${MINIMUM_STATE_MACHINE_DELAY_MS} ms). Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && typeof state.wakeAt === "number") {
    const minWakeAt = Date.now() + MINIMUM_STATE_MACHINE_DELAY_MS;
    if (state.wakeAt < minWakeAt) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAt must be at least 15 minutes in the future. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
}
