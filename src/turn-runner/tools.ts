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
import type { PGlite } from "@electric-sql/pglite";
import type { ActiveStateOutput } from "./state-machine-controller.js";
import { readSkillInstructions } from "./skills.js";

const jsonSchemaValidator = new Ajv({ strictSchema: false });

/**
 * Default cap (in seconds) applied to bash tool invocations that omit an
 * explicit timeout. Upstream's bash tool ships with no default timeout, so
 * stray commands like `find /` could otherwise run for many minutes before
 * anything intervenes. The model can still pass a larger `timeout` argument
 * for legitimate long-running work.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

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
  Pick<StateMachineAgentState, "prompt" | "systemPrompt" | "allowedSkills" | "inputSchema">
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
  /** Transient output from the currently running state, if one is active. */
  activeOutput?: ActiveStateOutput;
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
  getActiveStateOutput?: () => ActiveStateOutput | undefined;
  skills?: readonly Skill[];
  recallStorage?: RecallMemoryToolStorage;
}

export interface RecallMemoryToolStorage {
  /**
   * Returns the database used by the runner's MemoryStore, or undefined
   * when memory persistence is disabled (one-shot tools, tests). The
   * recall_memory tool no-ops when undefined so the model never sees a
   * tool whose backing store is missing.
   */
  getDb: () => PGlite | undefined;
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
      bash: { operations: withDefaultBashTimeout(createLocalBashOperations()) },
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
      Search the user's durable memory for facts, decisions, and prior context that may not be in the active prompt.

      The current memory section above shows the highest-signal cross-session reflections plus this session's compaction; call this tool when the user references something older or more specific. Hybrid retrieval (vector embeddings + keyword) returns the most relevant rows ranked by reciprocal rank fusion. Pass \`expand: true\` if a first call returned weak results and you want paraphrased variants to broaden the search.

      Do not use for general world knowledge or facts already visible in the rendered memory section.
    `,
    parameters: recallMemorySchema,
    async execute(_toolCallId, params) {
      const db = storage.getDb();
      if (!db) {
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
            db,
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
  return ["Current task list:", ...lines].join("\n");
}

function createStateMachineDefinitionTool(): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description: dedent`
      Create a state-machine definition for durable business-process work, or for any multi-step task whose steps are well-scoped enough that a sub-agent or script can complete each one on its own.

      Always create a state machine when the user asks for a recurring or unbounded task — anything shaped like "monitor X and do Y", "watch for X", "keep checking X until Y", "every N minutes/hours do X", or any work with no natural finish line in a single turn. Use a poll state for repeating checks (intervalMs) and a timer state for a single future wake (wakeAt). Once the parent turn ends, only state-machine work keeps running in the background; trying to handle these inline or with todo_write will simply stop when you reply.

      Reach for this tool — not todo_write — whenever a step can be described as "do X with these inputs and return the result." Each agent state runs in a fresh sub-agent context, and each script/poll/timer state runs without an agent at all. Only a compact result returns to you, so the sub-agent's tool calls, file reads, and script output never pollute this transcript. That makes a state machine the primary way to keep the parent context clean on multi-step work. The definition, current state, and progress are also rendered to the user in real time, so it doubles as a visible plan — they can see which state is running, what came before, and what is waiting.

      You stay the orchestrator: when each state finishes, the runner wakes you with its result so you can inspect the output and decide the next transition (select the next state, finalize with a terminal state, or hand back to the user). Sub-agents and scripts only do the per-state work; they do not pick what comes next.

      State-machine work also keeps the user unblocked. While states execute in the background the user can keep sending messages and you (the parent) will respond without waiting for the state machine to finish. State-machine progress continues regardless of what you do in that side reply — by default just answer the user. Only call select_state_machine_state if the user actually wants to redirect or change the running work; questions, status checks, and side conversations should be answered with plain replies. A "steer" message arrives immediately as an interruption (right shape for redirects or anything time-sensitive); a "follow_up" message is queued and delivered when your current turn settles (right shape for context that does not need to interrupt). Doing the same multi-step work via todo_write would block the user behind your own tool calls instead.

      Use todo_write instead only when you need to do the steps yourself in this conversation because you will keep reasoning over the intermediate output.

      State prompts and script commands may use template strings such as {{ input.email }}; define inputSchema on those states and pass matching input when selecting them. Agent states may set allowedSkills to restrict which skills are injected into that sub-agent.

      Poll states always run script attempts on a recurring intervalMs and fail the state machine when timeoutMs is exceeded. Timer states are separate: set kind "timer" with wakeAt as an absolute Unix epoch millisecond timestamp, and the state completes at that time so the parent can choose the next state.

      Poll intervalMs must be at least 15 minutes (900000 ms), and timer wakeAt must be at least 15 minutes in the future. State machines are for long-running lifecycle work that benefits from sleep/wake/background execution. Anything shorter-term should run directly in your turn rather than through a state machine — the orchestration overhead is not worth it for sub-15-minute waits.

      Every definition must include at least one terminal state with status "completed" representing the happy-path exit (success). The runner automatically adds terminal states named "failed" (status "failed") and "cancelled" (status "cancelled") if you do not define them, so you always have escape hatches for unrecoverable failure and user cancellation without specifying boilerplate terminals. You may still define your own "failed" or "cancelled" states (with reasons or different names) to override or supplement the auto-injected ones.

      Use this only when no state machine is active or the previous state machine has reached a terminal state; otherwise use select_state_machine_state.
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
    description:
      "Select the next state-machine state, terminal state, or failure outcome. When the selected state has inputSchema or template strings like {{ input.email }}, pass the matching input object here. Poll overrides must keep intervalMs set; timer overrides may replace wakeAt.",
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
  assertValidStateSchedule(effectiveState);
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
