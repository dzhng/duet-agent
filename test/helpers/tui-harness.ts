import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Renderable, TextareaRenderable } from "@opentui/core";
import { createTestRenderer, type MockInput } from "@opentui/core/testing";
import { FakePlaygroundRunner } from "../../examples/tui-playground.js";
import { createUpgradeStatusStream } from "../../src/cli/auto-upgrade.js";
import {
  Session,
  type SessionAnswerInput,
  type SessionPromptInput,
} from "../../src/session/session.js";
import { runTui } from "../../src/tui/app.js";
import type {
  TurnEvent,
  TurnQuestion,
  TurnTerminalEvent,
  TurnUsageEvent,
} from "../../src/types/protocol.js";

/**
 * Boot the real TUI on top of a `createTestRenderer` so synthetic
 * keystrokes flow through the same handler graph as production. Tests get
 * a `MockInput` to drive keys, recorded `session.prompt` /
 * `session.answer` calls to assert against, and a `dispose()` that tears
 * down the renderer + session cleanly.
 *
 * The harness wraps `FakePlaygroundRunner` from the playground example so
 * scenarios can be triggered the same way a developer would by typing
 * slash commands; tests can also call `runner.subscribe`-driven helpers
 * to push specific terminals (e.g. `ask` with custom questions).
 */
export interface TuiHarness {
  /** Synthetic keyboard from `@opentui/core/testing`. */
  mockInput: MockInput;
  /** Underlying playground runner; expose for scripted scenario emission. */
  runner: FakePlaygroundRunner;
  /** Live `Session` wrapping the runner. */
  session: Session;
  /**
   * Composer textarea pulled out of the layout via a tree walk. Exposed so
   * tests that need to drive `onPaste` directly (binary clipboards that
   * cannot be expressed through `mockInput.pasteBracketedText`) or assert
   * composer state can reach the same handle production wires up.
   */
  inputField: TextareaRenderable;
  /** Every `session.prompt(...)` call, in dispatch order. */
  promptCalls: SessionPromptInput[];
  /** Every `session.answer(...)` call, in dispatch order. */
  answerCalls: SessionAnswerInput[];
  /** Number of times `session.interrupt()` has been invoked. */
  interruptCalls: number;
  /** Number of times the TUI fired its `onResetRequest` callback. */
  resetRequestCalls: number;
  /**
   * Wait until either:
   *  - `session.answer` has been called at least `count` times (default 1), or
   *  - `timeoutMs` elapses, in which case the harness throws.
   * Use this after driving keys to confirm the picker dispatched.
   */
  waitForAnswer(options?: { count?: number; timeoutMs?: number }): Promise<void>;
  /**
   * Wait until `session.prompt` has been called at least `count` times
   * (default 1) or `timeoutMs` elapses. Useful when the test types text
   * and presses Enter outside of the picker.
   */
  waitForPrompt(options?: { count?: number; timeoutMs?: number }): Promise<void>;
  /**
   * Block until the session emits the next terminal event (`complete`,
   * `ask`, `interrupted`, or `sleep`), then resolve with it. Watches only
   * events emitted from the call point onward, so a prior turn's
   * terminal does not satisfy a fresh wait. Throws on timeout.
   */
  waitForTerminal(options?: { timeoutMs?: number }): Promise<TurnTerminalEvent>;
  /**
   * Snapshot the renderer's current frame as a plain-text string. Wraps
   * `createTestRenderer`'s `captureCharFrame` so tests can assert on
   * actually-painted content rather than internal state. Forces one
   * render cycle before snapshotting so handlers that mutated the scene
   * since the last natural tick (e.g. a synthetic event push) are
   * reflected in the captured cells.
   */
  captureCharFrame(): Promise<string>;
  /**
   * Push a single `ask` terminal with the provided questions. The TUI
   * reacts to the resulting state event and shows the picker. Returns
   * once the renderer has had a tick to react.
   */
  pushAskTerminal(questions: TurnQuestion[]): Promise<void>;
  /**
   * Push a single `usage` event with the provided payload so tests can
   * drive the sidebar bar with hand-crafted breakdowns. Returns once the
   * renderer has had a tick to repaint.
   */
  pushUsage(event: Omit<TurnUsageEvent, "type">): Promise<void>;
  /** Yield to the event loop so queued key events and microtasks drain. */
  flush(): Promise<void>;
  /** Tear down renderer, session, and the temp session directory. */
  dispose(): Promise<void>;
}

/**
 * Yield to the event loop so OpenTUI's stdin-decoder thread and the TUI
 * keypress handlers run before the next assertion. A single `setImmediate`
 * is enough for the synchronous parsing path; we use a couple to also
 * cover any microtask chains the session dispatcher schedules.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Depth-first walk for the first `TextareaRenderable` in the rendered tree.
 * The layout module only mounts one composer textarea, so the first hit is
 * the production input field. Used by the harness to expose `inputField`
 * without reaching into `runTui` internals.
 */
function findTextarea(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root;
  for (const child of root.getChildren()) {
    const hit = findTextarea(child as Renderable);
    if (hit) return hit;
  }
  return undefined;
}

async function waitForCount(
  read: () => number,
  target: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (read() < target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label}: expected >=${target} after ${timeoutMs}ms, got ${read()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export interface BootTuiOptions {
  width?: number;
  height?: number;
  /**
   * Working directory passed to `runTui`. Drives the `@`-file index and the
   * `/image <relative-path>` resolver. Defaults to `process.cwd()` so existing
   * tests stay unchanged.
   */
  workDir?: string;
}

export async function bootTui(options: BootTuiOptions = {}): Promise<TuiHarness> {
  const width = options.width ?? 100;
  const height = options.height ?? 32;
  const workDir = options.workDir ?? process.cwd();

  const { renderer, mockInput, captureCharFrame, renderOnce } = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
  });

  const sessionPath = await mkdtemp(join(tmpdir(), "duet-tui-harness-"));
  const runner = new FakePlaygroundRunner();
  const session = new Session(
    { model: "harness", cwd: process.cwd() },
    { id: "harness", sessionPath, runner, resumeFromStorage: false },
  );

  const promptCalls: SessionPromptInput[] = [];
  const answerCalls: SessionAnswerInput[] = [];
  let interruptCalls = 0;
  let resetRequestCalls = 0;
  // Mirror every event the Session emits so `pushAskTerminal` can wait
  // until the runner's `ask` has actually flowed Runner → Session → TUI
  // before returning. `Session.emit` iterates handlers synchronously, so
  // even though this recorder is registered before the TUI's own
  // subscriber (added inside `runTui` after this line), by the time the
  // poll loop wakes from its `setTimeout` the TUI handler has already run
  // through the same emit call and `showQuestions` has populated the
  // picker.
  const sessionEvents: TurnEvent[] = [];
  session.subscribe((event) => {
    sessionEvents.push(event);
  });
  const originalPrompt = session.prompt.bind(session);
  const originalAnswer = session.answer.bind(session);
  session.prompt = async (input: SessionPromptInput) => {
    promptCalls.push(input);
    return originalPrompt(input);
  };
  session.answer = async (input: SessionAnswerInput) => {
    answerCalls.push(input);
    return originalAnswer(input);
  };
  const originalInterrupt = session.interrupt.bind(session);
  session.interrupt = async () => {
    interruptCalls += 1;
    return originalInterrupt();
  };

  // Mirror what `cli/run.ts` does in production: always pass an
  // `upgradeStatus$` and publish a silent terminal status (the same one
  // `--no-auto-upgrade` and source-checkout invocations produce). Tests that
  // exercise the renderer must hit the same code path users hit, including
  // the upgrade-status subscriber — otherwise a regression there (e.g. the
  // orphan-renderable bug fixed in v0.1.65) goes undetected.
  const upgradeStatus$ = createUpgradeStatusStream();
  upgradeStatus$.complete({ kind: "skipped", reason: "disabled" });

  // Capture any rejection so it surfaces from `dispose()` instead of
  // becoming an unhandled promise rejection. A clean shutdown via
  // `renderer.destroy()` resolves `runTui` normally; only a real crash
  // populates `tuiError`.
  let tuiError: unknown;
  const tuiPromise = runTui({
    session,
    workDir,
    sessionId: "harness",
    packageName: "@duetso/agent",
    packageVersion: "harness",
    modelName: "harness",
    memoryModelName: "harness",
    upgradeStatus$,
    renderer,
    onResetRequest: () => {
      resetRequestCalls += 1;
    },
  }).catch((error) => {
    tuiError = error;
  });

  // Give runTui time to subscribe to the session and render the initial
  // frame before the test starts driving keys. Without this, the first
  // press can race the keypress handler registration.
  await yieldToEventLoop();
  await yieldToEventLoop();

  // Production `runTui` constructs the layout internally, so the test
  // harness reaches the composer Textarea by walking the rendered tree.
  // The layout only mounts one TextareaRenderable, so a depth-first hit
  // is unambiguous.
  const inputField = findTextarea(renderer.root);
  if (!inputField) {
    throw new Error("bootTui: failed to locate the composer TextareaRenderable in renderer tree");
  }

  // The boot transcript renders a "starter" section (recent sessions / cwd
  // suggestions) and intercepts Up/Down on an empty composer to navigate
  // its rows. In production the first user submit dismisses the section;
  // tests need to start from the post-dismiss state so the picker can own
  // arrow-key handling. Submit a known no-op slash command (`/clear-images`)
  // so `submit()` runs its starter-dismiss side effect without dispatching
  // a session prompt or leaving stray text in the composer. Typing `/`
  // opens the skill autocomplete; Escape closes it so the next Enter goes
  // straight to `submit` instead of completing an autocomplete item.
  await mockInput.typeText("/clear-images");
  await yieldToEventLoop();
  mockInput.pressEscape();
  await yieldToEventLoop();
  mockInput.pressEnter();
  await yieldToEventLoop();

  const harness: TuiHarness = {
    mockInput,
    runner,
    session,
    inputField,
    promptCalls,
    answerCalls,
    get interruptCalls() {
      return interruptCalls;
    },
    get resetRequestCalls() {
      return resetRequestCalls;
    },
    async waitForAnswer({ count = 1, timeoutMs = 1000 } = {}) {
      await waitForCount(() => answerCalls.length, count, timeoutMs, "waitForAnswer");
    },
    async waitForPrompt({ count = 1, timeoutMs = 1000 } = {}) {
      await waitForCount(() => promptCalls.length, count, timeoutMs, "waitForPrompt");
    },
    async waitForTerminal({ timeoutMs = 2000 } = {}) {
      // Watch from the call point onward so a prior terminal (e.g. the
      // playground's synthetic `complete` after the harness's `/clear-images`
      // submit, or an earlier turn in the same test) does not satisfy this
      // wait spuriously.
      const before = sessionEvents.length;
      const start = Date.now();
      while (true) {
        for (let i = before; i < sessionEvents.length; i++) {
          const event = sessionEvents[i]!;
          if (
            event.type === "complete" ||
            event.type === "ask" ||
            event.type === "interrupted" ||
            event.type === "sleep"
          ) {
            return event;
          }
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error(`waitForTerminal: no terminal event within ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    },
    async captureCharFrame() {
      // Drain pending microtasks so any event handler scheduled by the
      // most recent push has actually mutated the scene, then force a
      // render so `captureCharFrame` reads the post-mutation buffer
      // instead of a stale tick.
      await yieldToEventLoop();
      await renderOnce();
      return captureCharFrame();
    },
    async pushAskTerminal(questions) {
      // Bypass slash parsing by emitting an `ask` terminal as if a turn
      // had produced it. Session.handleTurnEvent awaits a state-file
      // write before fanning out, so we poll until our own subscriber
      // observes the ask — at which point the TUI's subscriber (added
      // earlier in `runTui`) has also already run `showQuestions`.
      const before = sessionEvents.length;
      runner.emitAskTerminal(questions);
      const start = Date.now();
      while (!sessionEvents.slice(before).some((event) => event.type === "ask")) {
        if (Date.now() - start > 1000) {
          throw new Error("pushAskTerminal: ask event never reached the session subscriber");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      // One extra tick so any synchronous render side effects (e.g. layout
      // measure) settle before the test starts pressing keys.
      await yieldToEventLoop();
    },
    async pushUsage(event) {
      // Same polling contract as `pushAskTerminal`: wait until the session
      // observer records the event so downstream handlers have run.
      const before = sessionEvents.length;
      runner.emitUsage(event);
      const start = Date.now();
      while (!sessionEvents.slice(before).some((e) => e.type === "usage")) {
        if (Date.now() - start > 1000) {
          throw new Error("pushUsage: usage event never reached the session subscriber");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await yieldToEventLoop();
    },
    async flush() {
      await yieldToEventLoop();
    },
    async dispose() {
      renderer.destroy();
      await tuiPromise;
      await session.dispose();
      await rm(sessionPath, { recursive: true, force: true });
      if (tuiError) throw tuiError;
    },
  };

  return harness;
}
