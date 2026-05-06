import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
  BoxRenderable,
  createCliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatCompactJson } from "../lib/compact-json.js";
import type { Session } from "../session/session.js";
import type { SkillCollision } from "../turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnEvent,
  TurnStep,
  TurnTerminalEvent,
  TurnTodo,
  TurnTokenUsage,
} from "../types/protocol.js";

export interface RunTuiInput {
  session: Session;
  initialPrompt?: string;
  /** Fully resolved provider:modelId string used for this CLI session. */
  modelName: string;
  /** Human-readable provenance for modelName, e.g. "inferred from ANTHROPIC_API_KEY in .env". */
  modelSource?: string;
  /** Fully resolved provider:modelId string used for observational memory work. */
  memoryModelName: string;
  /** Human-readable provenance for memoryModelName. */
  memoryModelSource?: string;
  /** Best-effort package update notice, shown in-TUI because stderr is hidden. */
  newVersionNotice?: string;
  /** Past messages to replay into the transcript on resume. */
  history?: AgentMessage[];
}

const COLORS = {
  user: "#7DD3FC",
  agent: "#FFFFFF",
  reasoning: "#9CA3AF",
  tool: "#A78BFA",
  system: "#FBBF24",
  error: "#F87171",
  hint: "#6B7280",
  status: "#34D399",
  border: "#374151",
} as const;

const HINT_IDLE = "Enter: send · Esc/Ctrl+C: quit";
const HINT_RUNNING = "Enter: steer · Shift+Enter: queue follow-up · Esc/Ctrl+C: interrupt";

/**
 * Runs the interactive TUI for a session. Resolves with the most recent
 * terminal event (if any) when the user exits the UI.
 *
 * Differentiating Enter vs Shift+Enter requires the terminal to report
 * modifier keys with Enter, which most terminals only do when the Kitty
 * keyboard protocol is enabled. We opt into it via `useKittyKeyboard`.
 */
export async function runTui(input: RunTuiInput): Promise<TurnTerminalEvent | undefined> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    targetFps: 60,
  });
  restoreWindowGlobal(previousWindow);

  const layout = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    scrollY: true,
    border: true,
    borderColor: COLORS.border,
    padding: 1,
  });

  const status = new TextRenderable(renderer, {
    content: "",
    fg: COLORS.status,
    height: 1,
    flexShrink: 0,
  });

  const hint = new TextRenderable(renderer, {
    content: HINT_IDLE,
    fg: COLORS.hint,
    height: 1,
    flexShrink: 0,
  });

  const inputBox = new BoxRenderable(renderer, {
    flexDirection: "row",
    border: true,
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });

  const prompt = new TextRenderable(renderer, {
    content: "> ",
    fg: COLORS.user,
    width: 2,
  });

  // Textarea (rather than Input) so long messages soft-wrap visually. Enter
  // is intercepted in onKeyDown below to submit instead of inserting a newline.
  const inputField = new TextareaRenderable(renderer, {
    placeholder: "Type a message and press Enter…",
    flexGrow: 1,
    minHeight: 1,
    maxHeight: 10,
    wrapMode: "word",
  });

  inputBox.add(prompt);
  inputBox.add(inputField);

  layout.add(transcript);
  layout.add(status);
  layout.add(hint);
  layout.add(inputBox);
  renderer.root.add(layout);
  inputField.focus();

  // ---- transcript helpers ----------------------------------------------------

  // ScrollBox.scrollHeight is only refreshed after the next layout pass, so
  // setting scrollTop synchronously right after adding a child reads stale
  // dimensions and leaves the view a few lines short of the bottom. Coalesce
  // scroll-to-bottom requests onto a single deferred tick instead.
  let scrollPending = false;
  function scrollToBottomSoon(): void {
    if (scrollPending) return;
    scrollPending = true;
    setTimeout(() => {
      scrollPending = false;
      transcript.scrollTop = transcript.scrollHeight;
    }, 0);
  }

  function appendLine(content: string, fg: string): void {
    if (!content) return;
    // ScrollBox children stack vertically; one Text per logical line keeps wrapping simple.
    const line = new TextRenderable(renderer, { content, fg });
    transcript.add(line);
    scrollToBottomSoon();
  }

  // Tool results can be huge (file dumps, search output). Show only the head
  // in the transcript so the conversation flow stays readable; the full
  // payload remains in session history for the model.
  const TOOL_RESULT_MAX_LINES = 3;
  function truncateToolResult(text: string): string {
    const lines = text.split("\n");
    if (lines.length <= TOOL_RESULT_MAX_LINES) return text;
    const head = lines.slice(0, TOOL_RESULT_MAX_LINES).join("\n");
    const remaining = lines.length - TOOL_RESULT_MAX_LINES;
    return `${head}\n… (+${remaining} more line${remaining === 1 ? "" : "s"})`;
  }

  function appendBlock(label: string | null, body: string, fg: string): void {
    beginBlock();
    const text = label ? `${label}\n${body}` : body;
    for (const line of text.split("\n")) appendLine(line, fg);
  }

  // Insert a blank separator before each new logical block so distinct steps
  // (text, reasoning, tool calls, system messages) are easy to tell apart.
  // The first block in the transcript skips the separator.
  let hasRenderedAnyBlock = false;
  function beginBlock(): void {
    if (hasRenderedAnyBlock) appendLine(" ", COLORS.hint);
    hasRenderedAnyBlock = true;
  }

  function setStatus(text: string): void {
    status.content = text;
  }

  function setHint(running: boolean): void {
    hint.content = running ? HINT_RUNNING : HINT_IDLE;
  }

  // ---- runtime state ---------------------------------------------------------

  let running = false;
  let lastTerminal: TurnTerminalEvent | undefined;
  let activeTextStream: StreamingBlock | undefined;
  let activeReasoningStream: StreamingBlock | undefined;
  // Tool calls fire twice (running → completed/error). Track the rendered
  // block by toolCallId so the second event updates the same line in place
  // — swapping the spinner for a check/cross and appending the result —
  // instead of pushing a separate block.
  const activeToolBlocks = new Map<string, ToolBlock>();

  interface StreamingBlock {
    line: TextRenderable;
    label: string | null;
    body: string;
    /** Cap rendered output to TOOL_RESULT_MAX_LINES for noisy streams (e.g. reasoning). */
    truncate: boolean;
  }

  interface ToolBlock {
    line: TextRenderable;
    toolName: string;
    inputBody: string;
  }

  function markRunning(): void {
    running = true;
    setHint(true);
    setStatus("● working… (Esc to interrupt)");
  }

  function markIdle(): void {
    running = false;
    setHint(false);
    setStatus("");
  }

  function reportError(error: unknown): void {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
    markIdle();
  }

  // ---- session subscription --------------------------------------------------

  const unsubscribe = input.session.subscribe((event: TurnEvent) => {
    if (event.type === "step") {
      renderStep(event.step);
    } else if (event.type === "todos") {
      renderTodos(event.todos);
    } else if (event.type === "follow_up_queue") {
      renderFollowUpQueue(event.prompts);
    } else if (event.type === "memory") {
      renderMemoryStatus(event);
    } else if (event.type === "system") {
      appendBlock("[system]", event.message, COLORS.system);
      if (event.level === "error") markIdle();
    } else if (event.type === "ask") {
      appendBlock("[question]", event.questions.map((q) => q.question).join("\n"), COLORS.system);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "complete") {
      if (event.error) {
        appendBlock("[error]", event.error, COLORS.error);
      } else if (event.result) {
        // Result is also normally streamed via text steps; only show if no streaming happened
        // for this turn (cheap heuristic: empty transcript-since-last-prompt).
        // Always-append is fine too — duplicate text is harmless and clearer for short turns.
      }
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "interrupted") {
      appendLine("[interrupted]", COLORS.system);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    } else if (event.type === "sleep") {
      appendLine(`[sleeping until ${new Date(event.wakeAt).toLocaleTimeString()}]`, COLORS.system);
      renderUsage(event.usage);
      lastTerminal = event;
      markIdle();
    }
  });

  function renderSetupIntro(
    skills: ReadonlyArray<{ name: string }>,
    agentFiles: readonly TurnAgentFile[],
    skillCollisions: readonly SkillCollision[],
  ): void {
    if (agentFiles.length === 0) {
      appendLine("[agent file] none", COLORS.hint);
    } else {
      appendLine(`[agent file] ${agentFiles.map((file) => file.name).join(", ")}`, COLORS.hint);
    }

    if (skills.length === 0) {
      appendLine("[skills] none", COLORS.hint);
    } else {
      const names = skills.map((skill) => skill.name).join(", ");
      appendLine(`[skills] ${skills.length} loaded: ${names}`, COLORS.hint);
    }

    for (const collision of skillCollisions) {
      appendLine(
        `[skill collision] "${collision.name}": kept ${collision.winnerPath}, ignored ${collision.loserPath}`,
        COLORS.system,
      );
    }
  }

  function renderUsage(usage?: TurnTokenUsage): void {
    if (!usage) return;
    const parts = [`in=${usage.inputTokens}`, `out=${usage.outputTokens}`];
    if (usage.cachedInputTokens !== undefined) parts.push(`cached=${usage.cachedInputTokens}`);
    const cost = usage.costUsd === undefined ? "" : ` · Cost: $${usage.costUsd.toFixed(4)}`;
    appendLine(`[usage] Tokens: ${parts.join(" ")}${cost}`, COLORS.hint);
  }

  function renderTodos(todos: TurnTodo[]): void {
    if (todos.length === 0) {
      appendBlock("[todos]", "No todos", COLORS.hint);
      return;
    }
    appendBlock(
      "[todos]",
      todos.map((todo) => `${todo.status} ${todo.id}: ${todo.content}`).join("\n"),
      COLORS.status,
    );
  }

  function renderFollowUpQueue(prompts: string[]): void {
    if (prompts.length === 0) {
      setStatus(running ? "● working… (Esc to interrupt)" : "");
      return;
    }
    setStatus(`queued follow-ups: ${prompts.length}`);
    appendBlock(
      "[follow-up queue]",
      prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n"),
      COLORS.hint,
    );
  }

  function renderStep(step: TurnStep): void {
    if (step.type === "text_delta") {
      activeTextStream = renderDelta(activeTextStream, null, step.delta, COLORS.agent);
    } else if (step.type === "reasoning_delta") {
      activeReasoningStream = renderDelta(
        activeReasoningStream,
        "[reasoning]",
        step.delta,
        COLORS.reasoning,
        true,
      );
    } else if (step.type === "text") {
      if (activeTextStream) {
        finalizeDelta(activeTextStream, step.text);
        activeTextStream = undefined;
        return;
      }
      appendBlock(null, step.text, COLORS.agent);
    } else if (step.type === "reasoning") {
      const trimmed = step.text.trim();
      if (activeReasoningStream) {
        finalizeDelta(activeReasoningStream, trimmed);
        activeReasoningStream = undefined;
        return;
      }
      if (trimmed) appendBlock("[reasoning]", truncateToolResult(trimmed), COLORS.reasoning);
    } else if (step.type === "tool_call") {
      renderToolCall(step);
    } else if (step.type === "system") {
      appendBlock("[system]", step.message, COLORS.system);
    }
  }

  function renderDelta(
    block: StreamingBlock | undefined,
    label: string | null,
    delta: string,
    fg: string,
    truncate = false,
  ): StreamingBlock {
    const next =
      block ??
      ({
        line: new TextRenderable(renderer, { content: "", fg }),
        label,
        body: "",
        truncate,
      } satisfies StreamingBlock);
    if (!block) {
      beginBlock();
      transcript.add(next.line);
    }
    next.body += delta;
    updateStreamingBlock(next);
    return next;
  }

  // Render a tool call as a single, self-updating block. The first event
  // (`status: "running"`) creates the block with a spinner; the second event
  // (`completed` or `error`) replaces the spinner with ✓/✗ and appends the
  // truncated result inline so the call and its outcome stay visually paired.
  function renderToolCall(step: Extract<TurnStep, { type: "tool_call" }>): void {
    const existing = activeToolBlocks.get(step.toolCallId);
    if (!existing) {
      const inputBody = step.input === undefined ? "" : formatCompactJson(step.input);
      const header = `[tool ${step.toolName}] ⏳`;
      const fg = step.status === "error" ? COLORS.error : COLORS.tool;
      const line = new TextRenderable(renderer, {
        content: inputBody ? `${header}\n${inputBody}` : header,
        fg,
      });
      beginBlock();
      transcript.add(line);
      const block: ToolBlock = { line, toolName: step.toolName, inputBody };
      activeToolBlocks.set(step.toolCallId, block);
      scrollToBottomSoon();
      // The same event may already carry a terminal status (cached/replayed
      // history). Fall through to finalize against the just-created block.
      if (step.status !== "running" && step.status !== "pending") {
        finalizeToolCall(step, block);
      }
      return;
    }
    finalizeToolCall(step, existing);
  }

  function finalizeToolCall(
    step: Extract<TurnStep, { type: "tool_call" }>,
    block: ToolBlock,
  ): void {
    const isError = step.status === "error";
    const marker = isError ? "✗" : "✓";
    const header = `[tool ${block.toolName}] ${marker}`;
    const sections = [block.inputBody ? `${header}\n${block.inputBody}` : header];
    if (step.output && step.output.length > 0) {
      const text = textFromContent(step.output);
      if (text) {
        const label = isError ? "[error]" : "[result]";
        sections.push(`${label}\n${truncateToolResult(text)}`);
      }
    }
    block.line.content = sections.join("\n");
    block.line.fg = isError ? COLORS.error : COLORS.tool;
    activeToolBlocks.delete(step.toolCallId);
    scrollToBottomSoon();
  }

  function finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  function updateStreamingBlock(block: StreamingBlock): void {
    const body = block.truncate ? truncateToolResult(block.body) : block.body;
    block.line.content = block.label ? `${block.label}\n${body}` : body;
    scrollToBottomSoon();
  }

  function renderMemoryStatus(event: Extract<TurnEvent, { type: "memory" }>): void {
    if (event.status === "running") {
      setStatus(`● ${event.message} (Esc to interrupt)`);
      return;
    }
    if (running) {
      setStatus("● working… (Esc to interrupt)");
    }
  }

  // ---- input handling --------------------------------------------------------

  // Track shift state for the most recent Enter keypress. The focused
  // InputRenderable handles its own `enter` event after onKeyDown fires, so we
  // capture the modifier here and read it during the ENTER event below.
  let lastEnterShift = false;

  let closingAfterInterrupt = false;

  const requestExit = async (): Promise<void> => {
    if (running) {
      if (closingAfterInterrupt) return;
      closingAfterInterrupt = true;
      setStatus("● interrupting…");
      try {
        await input.session.interrupt();
        await input.session.waitForTerminal();
      } catch (error) {
        reportError(error);
      } finally {
        renderer.stop();
      }
    } else {
      renderer.stop();
    }
  };

  // Attach directly to the focused InputRenderable. The Textarea-based input
  // consumes escape via its own keybindings before any global keypress handler
  // fires, so we intercept at the Renderable's onKeyDown hook which runs first.
  inputField.onKeyDown = (key: KeyEvent) => {
    if (key.name === "return" || key.name === "enter") {
      lastEnterShift = Boolean(key.shift);
      // Take over Enter so the textarea does not insert a newline. We submit
      // the current buffer contents and reset, regardless of shift state —
      // shift only differentiates steer vs. queued follow-up.
      const value = inputField.plainText.trim();
      inputField.clear();
      key.preventDefault();
      if (value) submit(value, lastEnterShift);
      lastEnterShift = false;
      return;
    }
    if (key.name === "escape") {
      void requestExit();
      return;
    }
    if (key.name === "c" && key.ctrl) {
      void requestExit();
    }
  };

  function submit(message: string, shiftEnter: boolean): void {
    appendBlock("you:", message, COLORS.user);

    if (running) {
      // Mid-turn: Enter → steer, Shift+Enter → queued follow-up.
      const behavior = shiftEnter ? "follow_up" : "steer";
      void input.session.prompt({ message, behavior }).catch(reportError);
      // Keep status as "working"; the existing turn continues.
      return;
    }

    // Idle: dispatch a prompt against the already-set-up session. Setup
    // happens before the TUI starts so skills are visible right away.
    void input.session.prompt({ message, behavior: "follow_up" }).catch(reportError);
    markRunning();
  }

  // ---- replay history on resume ---------------------------------------------

  if (input.newVersionNotice) {
    appendLine(input.newVersionNotice, COLORS.system);
  }
  const modelLine = input.modelSource
    ? `[model] ${input.modelName} — ${input.modelSource}`
    : `[model] ${input.modelName}`;
  appendLine(modelLine, COLORS.hint);
  const memoryModelLine = input.memoryModelSource
    ? `[memory model] ${input.memoryModelName} — ${input.memoryModelSource}`
    : `[memory model] ${input.memoryModelName}`;
  appendLine(memoryModelLine, COLORS.hint);

  // Setup already ran before the TUI launched, so we can read the resolved
  // skills/agent-files synchronously through the session getters.
  const [skills, agentFiles, skillCollisions] = await Promise.all([
    input.session.getSkills(),
    input.session.getResolvedAgentFiles(),
    input.session.getSkillCollisions(),
  ]);
  renderSetupIntro(skills, agentFiles, skillCollisions);

  if (input.history && input.history.length > 0) {
    for (const message of input.history) {
      renderHistoryMessage(message);
    }
    scrollToBottomSoon();
  }

  // ---- bootstrap initial prompt ----------------------------------------------

  if (input.initialPrompt) {
    appendBlock("you:", input.initialPrompt, COLORS.user);
    void input.session
      .prompt({ message: input.initialPrompt, behavior: "follow_up" })
      .catch(reportError);
    markRunning();
  } else {
    // No initial prompt — wait for the user. Setup already ran above, so
    // the skill summary is rendered before the user types.
    markIdle();
  }

  // ---- run renderer until the user quits -------------------------------------

  await new Promise<void>((resolve) => {
    const onDestroy = () => resolve();
    renderer.once("destroy", onDestroy);
    // Fallback — if the renderer is stopped without emitting destroy, settle on
    // process exit signals which createCliRenderer already wires up.
  });

  unsubscribe();
  return lastTerminal;

  // --------------------------------------------------------------------------

  function textFromContent(content: ReadonlyArray<TextContent | ImageContent>): string {
    return content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  function renderHistoryMessage(message: AgentMessage): void {
    if (!("role" in message)) return;
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") {
        appendBlock("you:", content, COLORS.user);
        return;
      }
      const text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) appendBlock("you:", text, COLORS.user);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") {
          appendBlock(null, block.text, COLORS.agent);
        } else if (block.type === "thinking") {
          const trimmed = block.thinking.trim();
          if (trimmed) appendBlock("[reasoning]", truncateToolResult(trimmed), COLORS.reasoning);
        } else if (block.type === "toolCall") {
          // Mirror the live flow: open the call as a running block keyed by
          // toolCallId. The matching toolResult message below finalizes it in
          // place, producing the same combined layout users see during a
          // live turn.
          renderToolCall({
            type: "tool_call",
            toolName: block.name,
            toolCallId: block.id,
            status: "running",
            input: block.arguments,
          });
        }
      }
      if (message.errorMessage) {
        appendBlock("[error]", message.errorMessage, COLORS.error);
      }
    } else if (message.role === "toolResult") {
      renderToolCall({
        type: "tool_call",
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        status: message.isError ? "error" : "completed",
        output: message.content,
      });
    }
  }
}

function restoreWindowGlobal(previousWindow: PropertyDescriptor | undefined): void {
  // OpenTUI installs `window.requestAnimationFrame` for browser-style
  // animation compatibility. In Bun, the presence of `window` can send fetch
  // internals down browser-only paths, while `global.requestAnimationFrame`
  // remains enough for OpenTUI after initialization.
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
    return;
  }
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
}
