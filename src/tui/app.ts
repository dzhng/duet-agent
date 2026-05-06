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
import type { Session } from "../session/session.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type {
  TurnEvent,
  TurnStep,
  TurnTerminalEvent,
  TurnTodo,
  TurnTokenUsage,
} from "../types/protocol.js";

export interface RunTuiInput {
  session: Session;
  started: boolean;
  initialPrompt?: string;
  mode: TurnRunnerConfig["mode"];
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

const HINT_IDLE = "Enter: send · Esc: quit · Ctrl+C: force quit";
const HINT_RUNNING =
  "Enter: steer · Shift+Enter: queue follow-up · Esc: interrupt · Ctrl+C: force quit";

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
    exitOnCtrlC: true,
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

  function appendLine(content: string, fg: string): void {
    if (!content) return;
    // ScrollBox children stack vertically; one Text per logical line keeps wrapping simple.
    const line = new TextRenderable(renderer, { content, fg });
    transcript.add(line);
    // Auto-stick to bottom on new content.
    transcript.scrollTop = transcript.scrollHeight;
  }

  function appendBlock(label: string | null, body: string, fg: string): void {
    const text = label ? `${label}\n${body}` : body;
    for (const line of text.split("\n")) appendLine(line, fg);
  }

  function setStatus(text: string): void {
    status.content = text;
  }

  function setHint(running: boolean): void {
    hint.content = running ? HINT_RUNNING : HINT_IDLE;
  }

  // ---- runtime state ---------------------------------------------------------

  let started = input.started;
  let running = false;
  let lastTerminal: TurnTerminalEvent | undefined;
  let activeTextStream: StreamingBlock | undefined;
  let activeReasoningStream: StreamingBlock | undefined;

  interface StreamingBlock {
    line: TextRenderable;
    label: string | null;
    body: string;
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
      if (trimmed) appendBlock("[reasoning]", trimmed, COLORS.reasoning);
    } else if (step.type === "tool_call") {
      const statusSuffix = step.status ? ` (${step.status})` : "";
      const header = `[tool ${step.toolName}${statusSuffix}]`;
      const body = step.input === undefined ? "" : JSON.stringify(step.input, null, 2);
      appendBlock(header, body, COLORS.tool);
      if (step.output && step.output.length > 0) {
        const text = textFromContent(step.output);
        if (text) {
          const isError = step.status === "error";
          const label = isError
            ? `[tool error ${step.toolName}]`
            : `[tool result ${step.toolName}]`;
          appendBlock(label, text, isError ? COLORS.error : COLORS.tool);
        }
      }
    } else if (step.type === "system") {
      appendBlock("[system]", step.message, COLORS.system);
    }
  }

  function renderDelta(
    block: StreamingBlock | undefined,
    label: string | null,
    delta: string,
    fg: string,
  ): StreamingBlock {
    const next =
      block ??
      ({
        line: new TextRenderable(renderer, { content: "", fg }),
        label,
        body: "",
      } satisfies StreamingBlock);
    if (!block) transcript.add(next.line);
    next.body += delta;
    updateStreamingBlock(next);
    return next;
  }

  function finalizeDelta(block: StreamingBlock, body: string): void {
    block.body = body;
    updateStreamingBlock(block);
  }

  function updateStreamingBlock(block: StreamingBlock): void {
    block.line.content = block.label ? `${block.label}\n${block.body}` : block.body;
    transcript.scrollTop = transcript.scrollHeight;
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

  const handleEsc = () => {
    if (running) {
      void input.session.interrupt().catch(reportError);
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
      handleEsc();
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

    // Idle: just start (or follow up) a fresh turn.
    if (!started) {
      void input.session.start({ prompt: message, mode: input.mode }).catch(reportError);
      started = true;
    } else {
      void input.session.prompt({ message, behavior: "follow_up" }).catch(reportError);
    }
    markRunning();
  }

  // ---- replay history on resume ---------------------------------------------

  if (input.history && input.history.length > 0) {
    for (const message of input.history) {
      renderHistoryMessage(message);
    }
    // scrollHeight depends on the next layout pass — defer one tick so the
    // resumed transcript opens scrolled to the latest message.
    setTimeout(() => {
      transcript.scrollTop = transcript.scrollHeight;
    }, 0);
  }

  // ---- bootstrap initial prompt ----------------------------------------------

  if (input.initialPrompt) {
    appendBlock("you:", input.initialPrompt, COLORS.user);
    if (!started) {
      void input.session
        .start({ prompt: input.initialPrompt, mode: input.mode })
        .catch(reportError);
      started = true;
    } else {
      void input.session
        .prompt({ message: input.initialPrompt, behavior: "follow_up" })
        .catch(reportError);
    }
    markRunning();
  } else if (input.started) {
    // Resumed session — assume nothing currently running until we see events.
    markIdle();
  } else {
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
          if (trimmed) appendBlock("[reasoning]", trimmed, COLORS.reasoning);
        } else if (block.type === "toolCall") {
          const body = JSON.stringify(block.arguments, null, 2);
          appendBlock(`[tool ${block.name}]`, body, COLORS.tool);
        }
      }
      if (message.errorMessage) {
        appendBlock("[error]", message.errorMessage, COLORS.error);
      }
    } else if (message.role === "toolResult") {
      const text = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) {
        const label = `[tool result ${message.toolName}${message.isError ? " error" : ""}]`;
        appendBlock(label, text, COLORS.tool);
      }
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
