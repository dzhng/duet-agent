import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  createCodingTools,
  createLocalBashOperations,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import dedent from "dedent";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { toXML } from "../lib/xml.js";
import { parseDurationToMs, parseWakeAtToMs } from "./duration.js";
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
import type { EmbedFn } from "../memory/embedding.js";
import { serializeMessageForObserver } from "../memory/observational.js";
import { recallMemoryExpanded, type RecallScope } from "../memory/recall.js";
import { buildAdvisorTranscript } from "../model-routing/advisor-transcript.js";
import { callAdvisor, type CallAdvisorInput } from "../model-routing/advisor.js";
import { ASK_ADVISOR_TOOL_DESCRIPTION } from "../model-routing/prompts.js";
import type { AdvisorGate } from "../model-routing/router.js";
import type { Observation } from "../types/memory.js";
import type { MemorySession } from "../memory/session.js";
import type { ActiveStateOutput } from "./state-machine-controller.js";
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
        "Replacement working directory for this sub-agent's coding tools (bash, read, write, edit). Set this whenever the work happens outside the session cwd — a git worktree, clone, or scratch dir a previous state created — instead of telling the sub-agent to `cd` in the prompt; the tools start here, so a path written into the prompt does not redirect them.",
    }),
    inputSchema: Type.Record(Type.String(), Type.Any(), {
      description:
        'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional.',
    }),
    forkContext: Type.Boolean({
      description:
        "When true, this sub-agent starts with a verbatim copy of the parent runner's full conversation context (prior discussion, decisions, tool history) instead of a fresh empty transcript. Defaults to false (fresh context), which is right for narrow, self-contained tasks. Set true only when the task depends on prior thread context that would be tedious or lossy to restate via prompt/input — forking copies the entire parent transcript, so leave it off for self-contained work.",
    }),
  }),
);

const scriptOverrideSchema = Type.Partial(
  Type.Object({
    command: Type.String({ description: "Replacement shell command for this script state." }),
    cwd: Type.String({
      description: "Replacement working directory for the command.",
    }),
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
    intervalMs: Type.Union([Type.Number(), Type.String()], {
      description:
        'Replacement recurring delay between poll wake attempts. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds.',
    }),
    timeoutMs: Type.Number({ description: "Replacement maximum poll-state runtime." }),
    command: Type.String({
      description: "Replacement shell command for one poll attempt.",
    }),
    cwd: Type.String({
      description: "Replacement working directory for the poll command.",
    }),
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
    wakeAt: Type.Union([Type.Number(), Type.String()], {
      description:
        'Replacement absolute wake time for this timer state. Accepts an ISO 8601 date string like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number.',
    }),
    wakeAfterMs: Type.Union([Type.Number(), Type.String()], {
      description:
        'Replacement relative duration measured from the moment the parent selects this timer state. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Mutually exclusive with wakeAt.',
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
        "Working directory for this sub-agent's coding tools (bash, read, write, edit). Set this whenever the work happens outside the session cwd — a git worktree, clone, or scratch dir a previous state created — instead of telling the sub-agent to `cd` in the prompt; the tools start here, so a path written into the prompt does not redirect them. Defaults to the state-machine session cwd.",
    }),
  ),
  forkContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, the sub-agent starts with a verbatim copy of the parent runner's full conversation context (prior discussion, decisions, tool history) instead of a fresh empty transcript. Defaults to false (fresh context), which is right for narrow, self-contained tasks. Set true only when the task depends on prior thread context that would be tedious or lossy to restate in the prompt — forking copies the entire parent transcript, so leave it off for self-contained work to keep the delegation cheaper and cleaner.",
    }),
  ),
});

const scriptStateSchema = Type.Object({
  ...baseStateSchema,
  kind: Type.Literal("script", { description: "Run a shell command for this state." }),
  command: Type.String({
    description: "Shell command to execute. May use templates like {{ input.email }}.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the state-machine session cwd.",
    }),
  ),
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
  intervalMs: Type.Union([Type.Number(), Type.String()], {
    description:
      'Recurring delay before the next scheduled poll attempt. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds.',
  }),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Maximum time this state may remain polling." }),
  ),
  command: Type.String({
    description:
      "Shell command for one poll attempt. Return non-empty JSON only when polling found a result.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the poll command. Defaults to the state-machine session cwd.",
    }),
  ),
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
      "Sleep until a future time, then resume with elapsedMs and timestamp output. Specify exactly one of wakeAt (absolute) or wakeAfterMs (relative).",
  }),
  wakeAt: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        'Absolute wake time when this timer state should complete. Accepts an ISO 8601 date string like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number. Mutually exclusive with wakeAfterMs.',
    }),
  ),
  wakeAfterMs: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        'Relative duration measured from the moment the parent selects this timer state, after which the timer should complete. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Mutually exclusive with wakeAt.',
    }),
  ),
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
  Pick<
    StateMachineAgentState,
    "prompt" | "systemPrompt" | "allowedSkills" | "cwd" | "inputSchema" | "forkContext"
  >
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
  Pick<StateMachineTimerState, "wakeAt" | "wakeAfterMs" | "inputSchema">
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
  firstState: Type.String({
    description:
      "Name of the state in `definition.states` to run first after creating the definition.",
  }),
  replaceActive: Type.Optional(
    Type.Boolean({
      description:
        "Set to true ONLY to deliberately abandon the state machine that is currently running and replace it with this new one. Creating a definition while a machine is still active is otherwise rejected: the active machine must first reach a terminal (advance or end it with select_state_machine_state). When this is true the runner cancels the active machine and starts this one in its place. Defaults to false, so an agent that did not realize a machine was running cannot clobber it by accident.",
    }),
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
      persistOverride: Type.Optional(
        Type.Boolean({
          description:
            "When `override` is set, controls whether the override is merged into the active state-machine definition (so the change sticks for every future run of this state) or applied as a one-shot just for this transition. Defaults to true — the orchestrator's typical reason to override is to tune a sub-agent prompt or fix a script command, and that tuning should persist. Set to false when you want to try a variation without committing it, e.g. probing a different prompt to see if the sub-agent recovers before deciding whether to keep the change. Ignored when `override` is omitted or when selecting a terminal state.",
        }),
      ),
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
  /**
   * When true (the default), an `override` is merged into the active
   * state-machine definition so future runs of the same state see the
   * tuned prompt/command/schedule. When false, the override applies only
   * to this transition and the stored definition is unchanged. Ignored
   * when `override` is undefined or when the target state is terminal.
   */
  persistOverride?: boolean;
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
  advisorStorage?: AskAdvisorToolStorage;
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

/** Lazy runtime inputs and router actions used by the parent-only advisor tool. */
export interface AskAdvisorToolStorage {
  /** Current parent transcript, read only when the tool executes. */
  getMessages: () => readonly AgentMessage[];
  /** Fully resolved executor prompt quoted into transcript content. */
  getSystemPrompt: () => string;
  /** Live local-session observation contents; empty when memory is disabled. */
  getObservations: () => Promise<readonly string[]>;
  /** Uniform transcript budget selected by the routed tier. */
  budgetTokens: number;
  /** Gateway-native advisor id, or a callback that resolves it lazily at tool execution. */
  modelName: string | (() => string);
  /** Reasoning effort selected by the routed tier. */
  thinkingLevel: ThinkingLevel;
  /** Atomically checks the floor and reserves the router's advisor slot when allowed. */
  advisorGate: () => AdvisorGate;
  /** Releases the reserved slot; false never stamps the floor or requests classification. */
  noteAdvisorConsult: (success?: boolean) => void;
  /** Network seam for deterministic tool tests; production uses callAdvisor. */
  callAdvisor?: (input: CallAdvisorInput) => Promise<{ advice: string }>;
}

export function createDefaultTurnRunnerTools(
  cwd: string,
  todoStorage: TodoWriteToolStorage,
  recallStorage?: RecallMemoryToolStorage,
  advisorStorage?: AskAdvisorToolStorage,
): AgentTool[] {
  const tools: AgentTool[] = [
    ...createCodingTools(cwd, {
      bash: {
        operations: withBundledRipgrep(withDefaultBashTimeout(createLocalBashOperations())),
      },
    }),
    createTodoWriteTool(todoStorage),
    createAskUserQuestionTool(),
  ];
  if (recallStorage) {
    tools.push(createRecallMemoryTool(recallStorage));
  }
  if (advisorStorage) {
    tools.push(createAskAdvisorTool(advisorStorage));
  }
  return tools;
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [
    ...createDefaultTurnRunnerTools(
      input.cwd,
      input.todoStorage,
      input.recallStorage,
      input.advisorStorage,
    ),
  ];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(createStateMachineDefinitionTool(input.getStateMachine, input.cwd));
  }

  const getDefinition =
    typeof input.mode === "object"
      ? () => input.mode as StateMachineDefinition
      : input.getDefinition;
  tools.push(createSelectStateTool(getDefinition, input.cwd));
  tools.push(createCurrentStateMachineStateTool(input.getStateMachine, input.getActiveStateOutput));
  return tools;
}

const askAdvisorSchema = Type.Object({});

/** Build the no-parameter, non-terminating advisor consultation tool. */
export function createAskAdvisorTool(
  storage: AskAdvisorToolStorage,
): AgentTool<typeof askAdvisorSchema> {
  return {
    name: "ask_advisor",
    label: "Ask advisor",
    description: ASK_ADVISOR_TOOL_DESCRIPTION,
    parameters: askAdvisorSchema,
    async execute(...args) {
      const signal = args[2];
      const gate = storage.advisorGate();
      const endConsult = (success: boolean) => storage.noteAdvisorConsult(success);
      if (!gate.allowed) {
        const text = gate.inFlight
          ? "An advisor consultation is already in progress. Continue without starting another."
          : `The advisor was consulted too recently. Continue for ${gate.stepsUntilAllowed} more assistant step${gate.stepsUntilAllowed === 1 ? "" : "s"} before asking again.`;
        return {
          content: [{ type: "text", text }],
          details: {
            type: "ask_advisor",
            rateLimited: true,
            stepsUntilAllowed: gate.stepsUntilAllowed,
            ...(gate.inFlight ? { inFlight: true } : {}),
          },
          terminate: false,
        };
      }

      const messages = storage.getMessages();
      const firstUserMessage = messages.find((message) => message.role === "user");
      if (!firstUserMessage) {
        endConsult(false);
        return {
          content: [{ type: "text", text: "The advisor transcript has no user message yet." }],
          details: { type: "ask_advisor", unavailable: true },
          terminate: false,
        };
      }
      let modelName: string;
      try {
        modelName =
          typeof storage.modelName === "function" ? storage.modelName() : storage.modelName;
        if (!modelName) throw new Error("advisor model unavailable");
      } catch {
        endConsult(false);
        return {
          content: [
            {
              type: "text",
              text: "The advisor model is unavailable for the configured providers.",
            },
          ],
          details: { type: "ask_advisor", unavailable: true },
          terminate: false,
        };
      }
      try {
        const transcript = buildAdvisorTranscript({
          firstUserMessage: serializeMessageForObserver(firstUserMessage),
          executorSystemPrompt: storage.getSystemPrompt(),
          observations: await storage.getObservations(),
          tailMessages: messages.map(serializeMessageForObserver),
          budgetTokens: storage.budgetTokens,
        });
        const result = await (storage.callAdvisor ?? callAdvisor)({
          transcriptText: transcript.text,
          modelName,
          thinkingLevel: storage.thinkingLevel,
          signal,
        });
        endConsult(true);
        return {
          content: [{ type: "text", text: result.advice }],
          details: {
            type: "ask_advisor",
            model: modelName,
            tokens: transcript.tokens,
          },
          terminate: false,
        };
      } catch (error) {
        endConsult(false);
        throw error;
      }
    },
  };
}

/**
 * Builds the agent-facing error thrown when `create_state_machine_definition`
 * is called while a machine is still running and `replaceActive` was not set.
 * The message names the active machine and its current state so the agent —
 * which may not have realized a machine was running — can decide whether to
 * advance/end it with select_state_machine_state or deliberately replace it
 * with `replaceActive: true`.
 */
function activeStateMachineCreateError(session: StateMachineSession): string {
  const name = session.definition.name;
  const currentState = session.currentState ?? "unknown";
  const kind = session.definition.states.find((state) => state.name === currentState)?.kind;
  const stateDescription = kind ? `${currentState} (${kind})` : currentState;
  return dedent`
    Cannot create a new state machine: a state machine is already active.

    Active machine: "${name}", currently at state "${stateDescription}".

    Advance or end it with select_state_machine_state before creating a new one. If you instead intend to abandon this machine and run a different one in its place, call create_state_machine_definition again with replaceActive: true to cancel the active machine and replace it.
  `;
}

export function applyStateOverride(
  state: StateMachineState,
  override: StateMachineStateOverride | undefined,
): StateMachineState {
  if (!override || override.kind !== state.kind) {
    return state;
  }

  const merged = { ...state, ...override.state } as StateMachineState;
  // Timer states must keep wakeAt and wakeAfterMs mutually exclusive: an
  // override that introduces one field must drop the other so downstream
  // validation and runtime resolution see exactly one schedule source.
  if (merged.kind === "timer" && override.kind === "timer") {
    const overrideState = override.state;
    if ("wakeAt" in overrideState && overrideState.wakeAt !== undefined) {
      delete (merged as StateMachineTimerState).wakeAfterMs;
    } else if ("wakeAfterMs" in overrideState && overrideState.wakeAfterMs !== undefined) {
      delete (merged as StateMachineTimerState).wakeAt;
    }
  }
  return merged;
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

      const { observations, vectorSearchAttempted, vectorSearchSucceeded, expanded } =
        await recallMemoryExpanded({
          session,
          ...(storage.embed ? { embed: storage.embed } : {}),
          query: params.query,
          limit,
          scope,
          ...(storage.sessionId ? { sessionId: storage.sessionId } : {}),
          // Only expand when the model asked for it and a paraphrase model is
          // configured; otherwise stay on the cheap single-query path.
          ...(params.expand && storage.expansionModel
            ? { expansionModel: storage.expansionModel }
            : {}),
        });

      const summary = observations.length
        ? observations.map(formatRecallHit).join("\n\n")
        : "(no matches)";
      // Degraded only when the vector path actually failed (embed threw
      // or the query errored). Zero vector hits from a healthy index are
      // a successful search and render the normal header.
      const header =
        vectorSearchAttempted && !vectorSearchSucceeded
          ? "# Memory recall (keyword-only fallback; semantic search unavailable)"
          : "# Memory recall";

      return {
        content: [{ type: "text", text: `${header}\n\n${summary}` }],
        details: {
          type: "recall_memory",
          query: params.query,
          scope,
          expanded,
          hits: observations.length,
          vectorSearchSucceeded,
        },
      };
    },
  };
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

      Hard cutoff: if the plan would have roughly seven or more items, or any item is itself a multi-step job (a whole refactor phase, a whole test file, a whole module extraction), do not use todo_write — use create_state_machine_definition with one agent state per item. Agent states have no minimum duration; only poll intervalMs and timer wakeAt/wakeAfterMs have the 15-minute floor. If you can already see the work will not fit in one session and you are tempted to recommend the user "continue in the next session," that is the signal that this tool was the wrong choice and a state machine was the right one. When work meets this cutoff it goes to create_state_machine_definition, and once it does, do NOT also call todo_write to mirror or track it: the state machine's states ARE the visible, live plan, so a parallel todo list duplicating those same phases is redundant and wrong. Dropping the todo list is the fix here, never dropping the state machine — session-spanning many-unit work still requires the state machine.

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
 * state-machine terminal so the parent gets to react to the outcome in
 * natural language before control returns to the user.
 *
 * The framing is deliberately neutral on "decided vs runtime failure":
 * the parent's own transcript already shows whether it selected the
 * terminal (its preceding `select_state_machine_state` tool call) or
 * whether the state machine ended on its own, and the terminal
 * `status`/`reason` carry the rest of what the parent needs to phrase
 * the reply. The prompt steers the parent toward a plain-text summary
 * and, by default, away from a control action on this turn: the machine
 * has ended, so the parent normally summarizes and returns control
 * rather than proactively starting more work. Follow-up work (new
 * machine or reactivation) is user-driven — it waits for the user's
 * request or a standing instruction to keep going, not the parent's own
 * initiative.
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

    Usually: reply to the user in plain text — summarize what happened and recommend what to do next, then let control return to them. Don't proactively spin up new work or resume this machine just because the tools are available.

    The exception is a standing instruction the user already gave: if they told you to keep going until the work is finished (or asked for follow-up this terminal does not yet satisfy), continuing is fine — call create_state_machine_definition for new work, or select a non-terminal state to reactivate and continue this machine. Absent that signal, default to summarizing and handing back.
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

function createStateMachineDefinitionTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  // Base directory used to resolve a relative state `cwd` before checking it
  // exists, matching the resolution used when the state actually runs.
  baseCwd: string,
): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    label: "Create state machine definition",
    description: dedent`
      Create a new state-machine definition for durable, multi-step, or recurring work. See the system prompt for full routing rules (when to choose this over todo_write, how states resume, terminal acknowledgment, etc.). This description only covers the call shape. The states you define here ARE the visible plan for this work, so do not also call todo_write to mirror or track the same phases; the state machine is already the plan surface.

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

      State \`kind\` is one of \`agent\`, \`script\`, \`poll\`, \`timer\`, \`terminal\`. Poll \`intervalMs\`, timer \`wakeAt\`, and timer \`wakeAfterMs\` must be ≥ 15 minutes; agent/script states have no minimum duration. Durations accept human-readable strings like \`"3h"\` or \`"5d"\` parsed by the \`ms\` package, and \`wakeAt\` accepts ISO 8601 strings like \`"2026-05-24T18:00:00Z"\`; raw millisecond numbers still work as a fallback. Timer states must set exactly one of \`wakeAt\` (absolute) or \`wakeAfterMs\` (relative from selection time). Every definition needs at least one \`terminal\` state with status "completed"; "failed" and "cancelled" terminals are auto-injected if omitted.

      State prompts and script commands may use \`{{ input.foo }}\` templates — declare \`inputSchema\` on those states and pass matching \`input\` when selecting them via select_state_machine_state. Agent states may set \`allowedSkills\` to restrict the skill set for that sub-agent.

      A per-state \`cwd\` must resolve to an existing directory at creation time, and a relative \`cwd\` resolves against the session working directory shown in the \`<cwd>\` block of the system prompt. If an earlier state creates that directory at runtime (a worktree, clone, or scratch dir), omit \`cwd\` here and set it via \`override.cwd\` on select_state_machine_state once the directory exists — do not point \`cwd\` at a path that does not exist yet.

      Only use this when no state machine is active or the previous one has reached a terminal state; otherwise call select_state_machine_state. Creating a definition while a machine is still active is rejected unless you set \`replaceActive: true\` to deliberately cancel the running machine and replace it.
    `,
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      // Reject create-while-active unless the agent explicitly opts into
      // replacing the running machine. The control tools terminate the worker
      // turn after one call, so the agent could not end the old machine in this
      // same turn — requiring replaceActive forces it to acknowledge the active
      // machine instead of clobbering one it may not know is running. Throwing
      // (rather than returning) keeps the worker turn alive so the agent can
      // react to the error and either advance the active machine or retry with
      // replaceActive: true.
      const active = getStateMachine?.();
      if (active && !active.terminal && params.replaceActive !== true) {
        throw new Error(activeStateMachineCreateError(active));
      }
      assertValidDefinition(params.definition, baseCwd);
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
  // Base directory used to resolve a relative state/override `cwd` before
  // checking it exists. Mirrors how the runner resolves a per-state cwd
  // (`cwdOverride ?? config.cwd ?? process.cwd()`) so validation rejects the
  // same missing directory the sub-agent's tools would otherwise start in.
  baseCwd: string,
): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    label: "Select state machine state",
    description: dedent`
      Select the next state-machine state. \`decision.state\` must exactly match one of the state names declared in the active definition; the named state's own kind in the definition (agent, script, poll, timer, or terminal) drives what runs. When the selected state has inputSchema or template strings like {{ input.email }}, pass the matching input object here. Poll overrides must keep intervalMs set; timer overrides may replace wakeAt or wakeAfterMs (exactly one).

      Carry forward what the orchestrator now knows. By default, agent states run in a fresh sub-agent context with no view of the previous state's transcript, tool output, or output value — they only see the rendered prompt and the input you pass here. So when a previous state surfaced facts the next state will need (file paths, IDs, error messages, decisions, summaries, root causes), either pass them as \`input\` (when the state's inputSchema has matching fields) or use \`override.prompt\` to inline the findings into the next state's prompt before running it. A static prompt that says "using the findings from the previous step" without inputs or an override is a bug: a fresh sub-agent has no way to read those findings, and neither your reasoning nor your reply text reaches it — this call's \`input\`/\`override.prompt\` is its only channel. Put the facts there on the FIRST select into a finding-dependent state; selecting it bare and adding context only after it comes back confused is the failure mode, not the fix. If restating the needed context would be lossy, set \`override.state.forkContext: true\` on an agent state so it starts with a copy of the parent transcript; leave it off for self-contained work because it copies the full context.

      The working directory is part of that carry-forward, and the most common thing orchestrators get wrong. The moment a state operates anywhere other than the session cwd — a git worktree, clone, sub-package, or scratch directory whose path an earlier state returned — set \`override.cwd\` (agent states) or the script/poll \`cwd\` to that path. Do this aggressively and by default for any out-of-tree work rather than waiting for the sub-agent to orient itself. Do NOT convey the location by writing "cd into /path" or "work in the worktree at /path" in the prompt: a sub-agent's coding tools (bash, read, write, edit) start in the \`cwd\` you set, not wherever the prompt mentions, so an inlined path leaves the tools pointed at the wrong tree while the narration reads correct. The path almost always comes from a previous state's output (e.g. a worktree path printed by an implement step) — capture it and pass it as \`override.cwd\` on that transition. A relative cwd resolves against the session working directory shown in the \`<cwd>\` block of the system prompt, so prefer an absolute path for a worktree or clone that lives outside it.

      Overrides persist by default. When you pass \`override\`, the merged state (prompt, command, schedule — whichever fields you set) is written back into the active definition, so every future run of that state uses the tuned version. This is the right shape when you are tightening a sub-agent prompt that hallucinated, fixing a script command that misbehaved, or tuning poll/timer cadence. Set \`persistOverride: false\` when you want a one-shot variation that does not commit — for example, probing a different prompt to see if the sub-agent recovers before deciding whether to keep the change. Persistence is a no-op for terminal states. \`override.kind\` must match the target state's kind; a mismatch is rejected outright (rather than silently dropping the override), and a per-state \`cwd\` that does not resolve to an existing directory is rejected too — fix the kind or the path before re-selecting.

      Selecting a terminal state ends the state machine. Every definition is guaranteed to have the auto-injected \`failed\` and \`cancelled\` terminals available, so to fail or cancel, just select one of those by name and optionally attach a \`reason\`. After a terminal you will be woken once more for an acknowledgment turn — the runner re-prompts you with the terminal details (state, status, reason) so you can summarize the outcome to the user in plain text. Default to that summary and let control return to the user; don't proactively start new work or call select_state_machine_state on the acknowledgment turn just because the tools are available.

      Follow-up is user-driven, not your own initiative. When the user asks to redo or continue a finished machine ("that's wrong, run X again"), reactivate it by selecting a non-terminal state, which clears the prior terminal and runs it live again from that state; for unrelated new work, call create_state_machine_definition. A standing instruction counts as that ask — if the user already told you to keep going until the work is done, continuing is appropriate.
    `,
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const definition = getDefinition?.();
      const decision: StateMachineRunnerDecision = {
        state: params.decision.state,
        reason: params.decision.reason,
        override: params.decision.override as StateMachineStateOverride | undefined,
        persistOverride: params.decision.persistOverride,
        input: params.decision.input,
      };
      assertValidSelectedState(decision, definition, baseCwd);

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
  baseCwd: string,
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

  // A kind-mismatched override is silently discarded by applyStateOverride —
  // prompt, cwd, and all — leaving the sub-agent to run with the original
  // definition state instead of the tuned one the caller thought they sent.
  // Reject it loudly so the caller fixes the override kind rather than
  // shipping work the runner quietly ignored.
  if (decision.override && decision.override.kind !== selectedState.kind) {
    throw new Error(
      `Override kind "${decision.override.kind}" does not match state "${selectedState.name}", which is a "${selectedState.kind}" state. Set override.kind to "${selectedState.kind}" so the override is applied instead of silently dropped.`,
    );
  }

  const effectiveState = applyStateOverride(selectedState, decision.override);
  assertValidStateInputSchema(effectiveState);
  assertValidStateSchedule(effectiveState);
  assertValidStateInput(effectiveState, decision.input);
  assertValidStateCwd(effectiveState, baseCwd, SELECT_CWD_GUIDANCE);
}

// Appended to the "cwd does not exist" error depending on where validation
// runs. At selection time the directory should already exist (an earlier
// state had a chance to create it). At creation time it often does not exist
// yet, so the right move is usually to omit cwd now and set it via
// override.cwd on select_state_machine_state once the directory is created.
const SELECT_CWD_GUIDANCE =
  "Set the override/state cwd to a directory that exists — typically the worktree or clone an earlier state created.";
const CREATE_CWD_GUIDANCE =
  "If an earlier state creates this directory at runtime, omit cwd here and set it via override.cwd on select_state_machine_state once the directory exists. Otherwise point it at a directory that already exists.";

// Resolve a per-state `cwd` (from a state definition or an override) against
// the runner's base cwd. A relative path resolves against `baseCwd` — the
// runner's config.cwd, set by --workDir, falling back to process.cwd() — so it
// lands in the directory the `<cwd>` system-prompt block advertises rather than
// the launching process's cwd, which Node would otherwise use. Used by both the
// runtime (agent/script/poll execution) and the select/create validators so a
// cwd is resolved identically wherever it is checked or run. `undefined`
// (no per-state cwd) falls back to the base.
export function resolveStateCwd(cwd: string | undefined, baseCwd: string): string {
  if (cwd === undefined) return baseCwd;
  return isAbsolute(cwd) ? cwd : resolve(baseCwd, cwd);
}

// A per-state `cwd` (from the definition or an override) becomes the working
// directory the sub-agent's coding tools start in. A path that does not exist
// or is not a directory lands the sub-agent in a broken/empty tree where it
// finds none of the files it was told to work on and reports "nothing to do".
function assertValidStateCwd(state: StateMachineState, baseCwd: string, guidance: string): void {
  const cwd =
    state.kind === "agent" || state.kind === "script" || state.kind === "poll"
      ? state.cwd
      : undefined;
  if (!cwd) return;

  const resolved = resolveStateCwd(cwd, baseCwd);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" does not exist (resolved to "${resolved}"). ${guidance}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" is not a directory (resolved to "${resolved}").`,
    );
  }
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

function assertValidDefinition(definition: StateMachineDefinition, baseCwd: string): void {
  for (const state of definition.states) {
    if (state.name === INTERRUPTED_STATE_MACHINE_STATE) {
      throw new Error(`State name "${INTERRUPTED_STATE_MACHINE_STATE}" is reserved.`);
    }
    assertValidStateInputSchema(state);
    assertValidStateSchedule(state);
    assertValidStateScheduleMinimum(state);
    assertValidStateCwd(state, baseCwd, CREATE_CWD_GUIDANCE);
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

// Shape validation: intervalMs / wakeAt must be present and parseable. Runs at
// both definition creation and state selection so malformed overrides are
// rejected too. Duration strings like "3h" / "5d" are accepted alongside raw
// millisecond numbers; ISO 8601 strings are accepted for absolute wakeAt.
function assertValidStateSchedule(state: StateMachineState): void {
  if (state.kind === "poll") {
    parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
  }
  if (state.kind === "timer") {
    const hasWakeAt = state.wakeAt !== undefined;
    const hasWakeAfter = state.wakeAfterMs !== undefined;
    if (hasWakeAt === hasWakeAfter) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": specify exactly one of wakeAt or wakeAfterMs.`,
      );
    }
    if (hasWakeAt) {
      parseWakeAtToMs(state.wakeAt, `Invalid timer schedule for state "${state.name}": wakeAt`);
    } else {
      parseDurationToMs(
        state.wakeAfterMs,
        `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
      );
    }
  }
}

// Minimum-cadence guidance: enforced only when a new definition is being
// created. Existing definitions handed to the runner via `mode:` may legitimately
// have shorter cadences from configuration the agent did not author, and the
// runtime should run them as-is rather than re-litigating the boundary.
function assertValidStateScheduleMinimum(state: StateMachineState): void {
  if (state.kind === "poll" && state.intervalMs !== undefined) {
    const intervalMs = parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
    if (intervalMs < MINIMUM_STATE_MACHINE_DELAY_MS) {
      throw new Error(
        `Invalid poll schedule for state "${state.name}": intervalMs must be at least 15 minutes (${MINIMUM_STATE_MACHINE_DELAY_MS} ms). Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAt !== undefined) {
    const wakeAt = parseWakeAtToMs(
      state.wakeAt,
      `Invalid timer schedule for state "${state.name}": wakeAt`,
    );
    const minWakeAt = Date.now() + MINIMUM_STATE_MACHINE_DELAY_MS;
    if (wakeAt < minWakeAt) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAt must be at least 15 minutes in the future. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAfterMs !== undefined) {
    const wakeAfterMs = parseDurationToMs(
      state.wakeAfterMs,
      `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
    );
    if (wakeAfterMs < MINIMUM_STATE_MACHINE_DELAY_MS) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAfterMs must be at least 15 minutes (${MINIMUM_STATE_MACHINE_DELAY_MS} ms). Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
}
