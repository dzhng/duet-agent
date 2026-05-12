import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatCompactJson } from "../lib/compact-json.js";

/**
 * Single source of truth for how tool calls render in the TUI transcript.
 *
 * Both the live renderer (`src/tui/app.ts`) and the resume-history renderer
 * (`src/tui/history.ts`) call `formatToolBlock`, so a tool's appearance stays
 * identical whether the user just watched it run or scrolled back into a
 * resumed session. Per-tool formatters trim the call's input down to the
 * fields a human cares about (e.g. the bash command, the edited path) and
 * decide whether to show the raw tool result inline or substitute a tighter
 * summary.
 */

/** Visual mode for the formatter. Some tools (like ask_user_question) hide
 * themselves live but still need a useful representation when replayed from
 * history, so the formatter sees which path it is on and can branch. */
export type ToolFormatMode = "live" | "history";

/** Status of a tool call as visible to the formatter. `running` covers the
 * pending/running spinner phase before any result is available; `completed`
 * and `error` carry the tool result. */
export type ToolCallStatus = "running" | "completed" | "error";

export interface ToolCallSpec {
  toolName: string;
  status: ToolCallStatus;
  input: unknown;
  /** Tool result content, present once status is `completed` or `error`. */
  output?: ReadonlyArray<TextContent | ImageContent>;
  mode: ToolFormatMode;
}

export interface FormattedTool {
  /**
   * Header line for the call, e.g. `"$ rg foo"` or `"[question]"`.
   *
   * The renderer prepends the running spinner / completion marker, so the
   * formatter does not include `⏳`, `✓`, or `✗` itself.
   */
  header: string;
  /** Lines shown under the header — typically a compact view of the input. */
  body?: string;
  /** Optional `[result]` / `[error]` block appended once the call finishes. */
  result?: { label: string; body: string };
  /** When true, the live renderer skips the call entirely; the terminal event
   *  that mirrors this tool (e.g. `ask`) is expected to handle display. */
  hidden?: boolean;
  /**
   * Whether the renderer should clamp `body` (input view) and `result.body`
   * (output) to a small visual height. Header and result label always render
   * in full. Defaults to `true`. Tools that produce structured, scannable
   * content the user is meant to read in full — todos, state machine status,
   * question/answer replays — set this to `false`.
   */
  clamp?: boolean;
}

/**
 * Generic source-line cap used outside the tool-block pipeline — reasoning
 * blocks, streaming snippets, and memory traces — to keep noisy text from
 * dominating the transcript. Tool inputs and outputs go through
 * `assembleToolBlock`, which applies a width-aware visual clamp instead.
 */
const TEXT_TRUNCATE_MAX_LINES = 3;

export function truncateToolText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TEXT_TRUNCATE_MAX_LINES) return text;
  const head = lines.slice(0, TEXT_TRUNCATE_MAX_LINES).join("\n");
  const remaining = lines.length - TEXT_TRUNCATE_MAX_LINES;
  return `${head}\n… (+${remaining} more line${remaining === 1 ? "" : "s"})`;
}

/**
 * Maximum visual rows the input or output body of a clampable tool may
 * occupy. Header and the `[result]` / `[error]` label always render in full;
 * only the body *content* is trimmed.
 */
export const TOOL_BODY_MAX_LINES = 3;

export interface AssembleToolBlockOptions {
  /**
   * Width in terminal columns available to the block. When provided, body
   * sections are soft-wrapped to this width before the row clamp so a single
   * very long line (e.g. minified JSON) collapses to a few visual rows plus
   * a "+N more" tail rather than spilling the whole transcript.
   */
  columns?: number;
}

/**
 * Assemble a formatted tool block into transcript text. Header and result
 * label always render in full; the input body and result body are clamped to
 * `TOOL_BODY_MAX_LINES` visual rows when `formatted.clamp` is left at its
 * default (`true`).
 */
export function assembleToolBlock(
  formatted: FormattedTool,
  marker: string,
  options: AssembleToolBlockOptions = {},
): string {
  const headerLine = `${formatted.header} ${marker}`.trimEnd();
  const clamp = formatted.clamp !== false;
  const inputBody =
    formatted.body && clamp ? clampBodyLines(formatted.body, options.columns) : formatted.body;
  const sections: string[] = [inputBody ? `${headerLine}\n${inputBody}` : headerLine];
  if (formatted.result && formatted.result.body) {
    const body = clamp
      ? clampBodyLines(formatted.result.body, options.columns)
      : formatted.result.body;
    sections.push(`${formatted.result.label}\n${body}`);
  }
  return sections.join("\n");
}

/**
 * Clamp a body section to `TOOL_BODY_MAX_LINES` visual rows. With a `columns`
 * width, each source line is char-wrapped first so wrap rows count toward
 * the cap. The remainder collapses into a `… (+N more line(s))` tail.
 */
function clampBodyLines(text: string, columns: number | undefined): string {
  const sourceLines = text.split("\n");
  const visualLines =
    columns && columns > 0 ? sourceLines.flatMap((line) => softWrap(line, columns)) : sourceLines;
  if (visualLines.length <= TOOL_BODY_MAX_LINES) return visualLines.join("\n");
  const head = visualLines.slice(0, TOOL_BODY_MAX_LINES).join("\n");
  const remaining = visualLines.length - TOOL_BODY_MAX_LINES;
  return `${head}\n… (+${remaining} more line${remaining === 1 ? "" : "s"})`;
}

function softWrap(line: string, columns: number): string[] {
  if (line.length === 0) return [""];
  if (line.length <= columns) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += columns) {
    out.push(line.slice(i, i + columns));
  }
  return out;
}

export function textFromToolContent(
  content: ReadonlyArray<TextContent | ImageContent> | undefined,
): string {
  if (!content) return "";
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Resolve the formatter for a tool call and produce its rendered block. */
export function formatToolBlock(spec: ToolCallSpec): FormattedTool {
  const formatter = TOOL_FORMATTERS[spec.toolName] ?? defaultFormatter;
  return formatter(spec);
}

type Formatter = (spec: ToolCallSpec) => FormattedTool;

function defaultFormatter(spec: ToolCallSpec): FormattedTool {
  const body =
    spec.input === undefined || spec.input === null ? undefined : formatCompactJson(spec.input);
  return {
    header: `[tool ${spec.toolName}]`,
    body,
    result: buildDefaultResult(spec),
  };
}

function buildDefaultResult(spec: ToolCallSpec): FormattedTool["result"] {
  if (spec.status === "running") return undefined;
  const text = textFromToolContent(spec.output);
  if (!text) return undefined;
  const label = spec.status === "error" ? "[error]" : "[result]";
  // Pass the raw text through; `assembleToolBlock` decides whether to clamp
  // based on the tool's `clamp` flag.
  return { label, body: text };
}

// ---- per-tool formatters --------------------------------------------------

const formatBash: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const command = stringField(input, "command") ?? "";
  const timeout = numberField(input, "timeout");
  const header = command ? `$ ${firstLine(command)}` : "$ ";
  const extraCommandLines = command.includes("\n")
    ? command.split("\n").slice(1).join("\n")
    : undefined;
  const bodyParts: string[] = [];
  if (extraCommandLines) bodyParts.push(extraCommandLines);
  if (timeout !== undefined) bodyParts.push(`(timeout ${timeout}s)`);
  return {
    header,
    body: bodyParts.length > 0 ? bodyParts.join("\n") : undefined,
    result: buildDefaultResult(spec),
  };
};

const formatRead: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const path = stringField(input, "path") ?? "?";
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  const range =
    offset !== undefined || limit !== undefined ? ` (${formatLineRange(offset, limit)})` : "";
  return {
    header: `read ${path}${range}`,
    result: buildDefaultResult(spec),
  };
};

const formatEdit: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const path = stringField(input, "path") ?? "?";
  const edits = arrayField(input, "edits");
  const count = edits?.length ?? 0;
  const summary = count > 0 ? ` (${count} edit${count === 1 ? "" : "s"})` : "";
  return {
    header: `edit ${path}${summary}`,
    result: buildDefaultResult(spec),
  };
};

const formatWrite: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const path = stringField(input, "path") ?? "?";
  const content = stringField(input, "content");
  const sizeNote =
    content !== undefined ? ` (${content.length} byte${content.length === 1 ? "" : "s"})` : "";
  return {
    header: `write ${path}${sizeNote}`,
    result: buildDefaultResult(spec),
  };
};

const formatGrep: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const pattern = stringField(input, "pattern") ?? "";
  const path = stringField(input, "path");
  const glob = stringField(input, "glob");
  const flagBits: string[] = [];
  if (booleanField(input, "ignoreCase")) flagBits.push("i");
  if (booleanField(input, "literal")) flagBits.push("literal");
  const tail: string[] = [];
  if (path) tail.push(path);
  if (glob) tail.push(`glob=${glob}`);
  if (flagBits.length > 0) tail.push(`[${flagBits.join(",")}]`);
  const tailText = tail.length > 0 ? ` ${tail.join(" ")}` : "";
  return {
    header: `grep ${JSON.stringify(pattern)}${tailText}`,
    result: buildDefaultResult(spec),
  };
};

const formatLs: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const path = stringField(input, "path") ?? ".";
  return { header: `ls ${path}`, result: buildDefaultResult(spec) };
};

const formatFind: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const pattern = stringField(input, "pattern") ?? "";
  const path = stringField(input, "path");
  const tail = path ? ` in ${path}` : "";
  return {
    header: `find ${JSON.stringify(pattern)}${tail}`,
    result: buildDefaultResult(spec),
  };
};

interface QuestionLike {
  question: string;
  header?: string;
  options: Array<{ label: string }>;
  multiSelect?: boolean;
}

const formatAskUserQuestion: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const questionsRaw = arrayField(input, "questions") ?? [];
  const questions = questionsRaw.filter(isQuestionLike);
  const body = questions
    .map((q) => {
      const heading = q.header ? `${q.header}\n` : "";
      const options = q.options.map((opt) => `  • ${opt.label}`).join("\n");
      return `${heading}${q.question}${options ? `\n${options}` : ""}`;
    })
    .join("\n\n");

  if (spec.mode === "live") {
    // The runner emits an `ask` terminal event that already prints
    // `[question]` and surfaces the picker. Hiding the tool_call avoids the
    // duplicate transcript entry; on resume the history formatter reproduces
    // the same `[question]` block from the persisted call.
    return { header: "[question]", body, hidden: true };
  }

  // History mode: no terminal event replays, so this block carries the full
  // Q&A. Pull the chosen answer out of the tool result if available.
  const answerText = textFromToolContent(spec.output).trim();
  const result = answerText ? { label: "→", body: extractAnswerSummary(answerText) } : undefined;
  // Question/answer replays read better in full; the answer is small.
  return { header: "[question]", body, result, clamp: false };
};

function extractAnswerSummary(rawAnswer: string): string {
  // Tool results from ask_user_question are wrapped in an XML envelope by
  // the runner. Pull out the answer values when we recognize them; otherwise
  // fall back to the raw string so nothing is silently dropped.
  const matches = [...rawAnswer.matchAll(/<answers>([\s\S]*?)<\/answers>/g)];
  if (matches.length === 0) return rawAnswer;
  return matches
    .map((m) => m[1]!.replace(/<[^>]+>/g, "").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function isQuestionLike(value: unknown): value is QuestionLike {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.question === "string" && Array.isArray(v.options);
}

const formatTodoWrite: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const merge = booleanField(input, "merge");
  const todos = arrayField(input, "todos") ?? [];
  const verb = merge ? "todo update" : "todo replace";
  const lines = todos
    .map((todo) => {
      if (!todo || typeof todo !== "object") return undefined;
      const t = todo as Record<string, unknown>;
      const status = typeof t.status === "string" ? t.status : "?";
      const id = typeof t.id === "string" ? t.id : "?";
      const content = typeof t.content === "string" ? t.content : "";
      return `${todoStatusGlyph(status)} ${id}: ${content}`;
    })
    .filter((line): line is string => line !== undefined);
  return {
    header: `${verb} (${todos.length})`,
    body: lines.length > 0 ? lines.join("\n") : undefined,
    // Suppress the stock `[result]` block — todo_write only echoes the same
    // todos back, which the body already shows.
    result: undefined,
    // Todo lists are meant to be read in full; never trim them.
    clamp: false,
  };
};

function todoStatusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "▸";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}

const formatReadSkill: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const name = stringField(input, "name") ?? "?";
  return { header: `read skill: ${name}`, result: buildDefaultResult(spec) };
};

const formatCreateStateMachine: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const definition = pickObject(input ? input["definition"] : undefined);
  const smName = stringField(definition, "name") ?? "?";
  const states = arrayField(definition, "states") ?? [];
  const stateNames = states
    .map((s) =>
      s && typeof s === "object" ? stringField(s as Record<string, unknown>, "name") : undefined,
    )
    .filter((s): s is string => Boolean(s));
  const body = stateNames.length > 0 ? `states: ${stateNames.join(", ")}` : undefined;
  return {
    header: `loops ▶ ${smName}`,
    body,
    result: buildDefaultResult(spec),
    // State-machine status is structured and short; show it in full.
    clamp: false,
  };
};

const formatSelectStateMachineState: Formatter = (spec) => {
  const input = pickObject(spec.input);
  const decision = pickObject(input ? input["decision"] : undefined);
  const kind = stringField(decision, "kind") ?? "?";
  const stateName = stringField(decision, "state");
  const reason = stringField(decision, "reason");
  const tail = stateName ? ` ${stateName}` : "";
  const reasonNote = reason ? `reason: ${reason}` : undefined;
  return {
    header: `→ ${kind}${tail}`,
    body: reasonNote,
    result: buildDefaultResult(spec),
    clamp: false,
  };
};

const formatGetCurrentStateMachineState: Formatter = (spec) => ({
  header: "loops status",
  result: buildDefaultResult(spec),
  clamp: false,
});

const TOOL_FORMATTERS: Record<string, Formatter> = {
  bash: formatBash,
  read: formatRead,
  edit: formatEdit,
  write: formatWrite,
  grep: formatGrep,
  ls: formatLs,
  find: formatFind,
  ask_user_question: formatAskUserQuestion,
  todo_write: formatTodoWrite,
  read_skill: formatReadSkill,
  create_state_machine_definition: formatCreateStateMachine,
  select_state_machine_state: formatSelectStateMachineState,
  get_current_state_machine_state: formatGetCurrentStateMachineState,
};

// ---- helpers --------------------------------------------------------------

function pickObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function numberField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function booleanField(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

function arrayField(obj: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

function formatLineRange(offset?: number, limit?: number): string {
  if (offset !== undefined && limit !== undefined) {
    return `lines ${offset}–${offset + limit - 1}`;
  }
  if (offset !== undefined) return `from line ${offset}`;
  if (limit !== undefined) return `first ${limit} line${limit === 1 ? "" : "s"}`;
  return "";
}
