import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { TurnRunner, type AgentConfigInput } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState, TurnTerminalEvent, TurnTodo } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { delay, waitFor } from "./helpers/async.js";
import { createAssistantMessage } from "./helpers/messages.js";
import { createStateMachineState, startTurn } from "./helpers/turn-runner-protocol.js";

/**
 * Feed a plain-text response for the parent's terminal acknowledgment
 * turn, which fires once after every state-machine terminal so the
 * parent can summarize the outcome to the user (and optionally start
 * follow-up work). Most active-turns tests do not exercise the
 * acknowledgment text itself; they just need the turn to settle so the
 * outer `await turn` can resolve.
 */
async function ackTerminal(
  runner: StreamingTurnRunner,
  text = "Done — state machine completed.",
): Promise<void> {
  await waitFor(() => runner.pendingStreams.length === 1);
  runner.completeNext(text);
}

class StreamingTurnRunner extends TurnRunner {
  readonly contexts: Context[] = [];
  readonly pendingStreams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  agentsCreated = 0;

  constructor() {
    super({
      model: "anthropic:claude-opus-4-7",
      skillDiscovery: { includeDefaults: false },
    });
  }

  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner["createAgent"]>[1],
  ): Agent {
    this.agentsCreated += 1;
    const agent = super.createAgent(input, onControlResult);
    agent.streamFn = (_model, context) => {
      this.contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      const stream = createAssistantMessageEventStream();
      this.pendingStreams.push(stream);
      return stream;
    };
    return agent;
  }

  completeNext(text: string, options?: { error?: string }): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "stop",
      message: createAssistantMessage({ text, errorMessage: options?.error }),
    });
  }

  completeNextToolCall(name: string, args: Record<string, unknown>): void {
    const stream = this.pendingStreams.shift();
    if (!stream) throw new Error("No pending stream");
    stream.push({
      type: "done",
      reason: "toolUse",
      message: createAssistantMessage({
        text: "",
        extraContent: [
          { type: "toolCall", id: `tool_${this.contexts.length}`, name, arguments: args },
        ],
      }),
    });
  }
}

describe("TurnRunner active turns", () => {
  test("rejects non-start commands before turn_started is emitted", async () => {
    const { runner } = createStreamingRunner();

    await expect(
      runner.turn({ type: "prompt", message: "too early", behavior: "follow_up" }),
    ).rejects.toThrow("Turn runner has not been started.");
    expect(() => runner.interrupt({ type: "interrupt" })).toThrow(
      "Turn runner has not been started.",
    );
    expect(() =>
      runner.editFollowUpQueue({ type: "edit_follow_up_queue", prompts: [{ message: "later" }] }),
    ).toThrow("Turn runner has not been started.");
  });

  test("repeated prompt turns join the active agent chain and emit one terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "first" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const second = runner.turn({
      type: "prompt",
      message: "second",
      behavior: "follow_up",
    });
    await waitFor(() => followUpQueueEvents(events).some((queue) => queue[0] === "second"));
    expect(followUpQueueEvents(events)).toContainEqual(["second"]);

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(followUpQueueEvents(events).at(-1)).toEqual([]);
    runner.completeNext("second response");

    const [firstTerminal, secondTerminal] = await Promise.all([first, second]);
    expect(firstTerminal).toBe(secondTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(firstTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(messageTexts(firstTerminal.state)).toEqual([
      "first",
      "first response",
      "second",
      "second response",
    ]);
  });

  test("uses one parent agent across multiple pi-agent turns in a session", async () => {
    const { runner } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "first" });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("first response");
    await first;

    const second = runner.turn({
      type: "prompt",
      message: "second",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("second response");
    await second;

    expect(runner.agentsCreated).toBe(1);
  });

  test("editing active follow-up queue replaces queued prompts", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "first" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const queued = runner.turn({
      type: "prompt",
      message: "queued before edit",
      behavior: "follow_up",
    });
    await waitFor(() =>
      followUpQueueEvents(events).some((queue) => queue[0] === "queued before edit"),
    );
    runner.editFollowUpQueue({
      type: "edit_follow_up_queue",
      prompts: [{ message: "replacement follow-up" }],
    });

    expect(followUpQueueEvents(events)).toContainEqual(["queued before edit"]);
    expect(followUpQueueEvents(events)).toContainEqual(["replacement follow-up"]);
    runner.completeNext("first response");
    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("replacement follow-up");
    expect(lastUserText(runner.contexts[1]!)).not.toContain("queued before edit");
    runner.completeNext("replacement response");

    const [firstTerminal, queuedTerminal] = await Promise.all([first, queued]);
    expect(firstTerminal).toBe(queuedTerminal);
    expect(followUpQueueEvents(events).at(-1)).toEqual([]);
  });

  test("hydrates persisted follow-up queue and injects it into the next parent agent", async () => {
    const { runner, events } = createStreamingRunner();
    const state: TurnState = {
      status: "completed",
      mode: "agent",
      agent: { status: "completed", messages: [] },
      followUpQueue: [{ message: "persisted follow-up" }],
    };

    await runner.start({ type: "start", state: JSON.parse(JSON.stringify(state)) as TurnState });
    const turn = runner.turn({
      type: "prompt",
      message: "resume",
      behavior: "follow_up",
    });
    await waitFor(() => runner.contexts.length >= 1);
    expect(lastUserText(runner.contexts[0]!)).toContain("resume");
    runner.completeNext("resume response");
    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("persisted follow-up");
    runner.completeNext("follow-up response");

    const terminal = await turn;
    expect(messageTexts(terminal.state)).toEqual([
      "resume",
      "resume response",
      "persisted follow-up",
      "follow-up response",
    ]);
    expect(followUpQueueEvents(events).at(-1)).toEqual([]);
  });

  test("persists todos in turn state snapshots", async () => {
    const { runner } = createStreamingRunner();
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "write todos" });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("todo_write", {
      merge: false,
      todos: [{ id: "todo", content: "Keep todo state", status: "in_progress" }],
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    expect(runner.getState()?.todos).toEqual([
      { id: "todo", content: "Keep todo state", status: "in_progress" },
    ]);
    runner.completeNext("done");

    const terminal = await turn;
    expect(terminal.state.todos).toEqual([
      { id: "todo", content: "Keep todo state", status: "in_progress" },
    ]);
  });

  test("replacing todos in a follow-up turn keeps the new list in the terminal snapshot", async () => {
    const { runner } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "plan work" });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("todo_write", {
      merge: false,
      todos: [
        { id: "a1", content: "Old item 1", status: "in_progress" },
        { id: "a2", content: "Old item 2", status: "pending" },
      ],
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("planned");
    await first;

    const second = runner.turn({
      type: "prompt",
      message: "rewrite the plan",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("todo_write", {
      merge: false,
      todos: [
        { id: "b1", content: "New item 1", status: "completed" },
        { id: "b2", content: "New item 2", status: "in_progress" },
      ],
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("done");

    const terminal = await second;
    const expected: TurnTodo[] = [
      { id: "b1", content: "New item 1", status: "completed" },
      { id: "b2", content: "New item 2", status: "in_progress" },
    ];
    expect(runner.getState()?.todos).toEqual(expected);
    expect(terminal.state.todos).toEqual(expected);
  });

  test("steer is handled through turn and still shares the active terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "first" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const steer = runner.turn({
      type: "prompt",
      message: "steer now",
      behavior: "steer",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("steered response");

    const [firstTerminal, steerTerminal] = await Promise.all([first, steer]);
    expect(firstTerminal).toBe(steerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(messageTexts(firstTerminal.state)).toContain("steer now");
  });

  test("answers behave like prompts after serialization during active turns", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, {
      mode: "agent",
      prompt: "ask me later",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { choice: ["A"] },
      behavior: "follow_up",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("answer response");

    const [firstTerminal, answerTerminal] = await Promise.all([first, answer]);
    expect(firstTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(messageTexts(firstTerminal.state).join("\n")).toContain("Here are my answers");
  });

  test("answer commands serialize multi-element answer arrays in option order", async () => {
    const { runner } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, {
      mode: "agent",
      prompt: "ask me later",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      questions: [
        {
          question: "Suites",
          multiSelect: true,
          options: [{ label: "unit" }, { label: "integration" }, { label: "e2e" }],
        },
      ],
      answers: { Suites: ["unit", "e2e"] },
      behavior: "follow_up",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("answer response");

    await Promise.all([first, answer]);
    const flushedText = lastUserText(runner.contexts[1]!);
    expect(flushedText).toContain("unit");
    expect(flushedText).toContain("e2e");
    expect(flushedText.indexOf("unit")).toBeLessThan(flushedText.indexOf("e2e"));
  });

  test("answer commands with a whitespace-only message produce no trailing prompt", async () => {
    const { runner } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, {
      mode: "agent",
      prompt: "ask me later",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { "Pick one": ["A"] },
      behavior: "follow_up",
      message: "   \n  \t  ",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("answer response");

    await Promise.all([first, answer]);
    const flushedText = lastUserText(runner.contexts[1]!);
    // No trailing whitespace-only "prompt" should be appended; the message
    // ends with the closing `</answers>` block (modulo trailing newlines).
    expect(flushedText.trimEnd().endsWith("</answers>")).toBe(true);
  });

  test("answer commands append the optional free-form message after the answer XML", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, {
      mode: "agent",
      prompt: "ask me later",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      questions: [
        { question: "Pick env", options: [{ label: "staging" }] },
        {
          question: "Suites",
          multiSelect: true,
          options: [{ label: "unit" }, { label: "e2e" }],
        },
      ],
      answers: { "Pick env": ["staging"] },
      behavior: "follow_up",
      message: "also bump the changelog",
    });

    runner.completeNext("first response");
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("answer response");

    await Promise.all([first, answer]);
    expect(terminalEvents(events)).toHaveLength(1);
    const answerContext = runner.contexts[1];
    expect(answerContext).toBeDefined();
    const flushedText = lastUserText(answerContext!);
    expect(flushedText).toContain("Here are my answers to your questions.");
    expect(flushedText).toContain("staging");
    // Multi-select question with no entry in `answers` should still serialize
    // its question text so the model sees the gap explicitly.
    expect(flushedText).toContain("Suites");
    expect(flushedText).toContain("also bump the changelog");
    const xmlIndex = flushedText.indexOf("</answers>");
    const trailingIndex = flushedText.indexOf("also bump the changelog");
    expect(xmlIndex).toBeGreaterThan(-1);
    expect(trailingIndex).toBeGreaterThan(xmlIndex);
  });

  test("chain of prompt → prompt → wake → prompt → prompt emits exactly one terminal", async () => {
    // Mirrors what the RPC loop must forward into the runner: several
    // turn-driving commands arrive while the chain is in flight, including
    // a no-op wake. The runner queues them onto the active chain and emits
    // a single terminal whose state reflects all four prompts.
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "first" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const second = runner.turn({ type: "prompt", message: "second", behavior: "follow_up" });
    await waitFor(() => followUpQueueEvents(events).some((queue) => queue.includes("second")));
    const wake = runner.turn({ type: "wake" });
    const third = runner.turn({ type: "prompt", message: "third", behavior: "follow_up" });
    await waitFor(() => followUpQueueEvents(events).some((queue) => queue.includes("third")));
    const fourth = runner.turn({ type: "prompt", message: "fourth", behavior: "follow_up" });
    await waitFor(() => followUpQueueEvents(events).some((queue) => queue.includes("fourth")));

    // The parent agent runs one pi-agent turn per consumed follow-up.
    runner.completeNext("first response");
    for (const reply of ["second response", "third response", "final response"]) {
      await waitFor(() => runner.pendingStreams.length === 1);
      runner.completeNext(reply);
    }

    const [a, b, c, d, e] = await Promise.all([first, second, wake, third, fourth]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toBe(e);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(a).toMatchObject({ type: "complete", status: "completed" });
    expect(a.type === "complete" ? a.result : undefined).toBe("final response");
    const texts = messageTexts(a.state);
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    expect(texts).toContain("third");
    expect(texts).toContain("fourth");
    // The queued wake on a non-sleeping session must not leak a
    // "Nothing to wake." terminal into the chain.
    expect(a.type === "complete" ? a.result : undefined).not.toBe("Nothing to wake.");
  });

  test("queued wake behind a prompt is dropped instead of clobbering the prompt's terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "finish work" });
    await waitFor(() => runner.pendingStreams.length === 1);

    // Queue a wake mid-turn. The session is not sleeping, so the wake has
    // no work to do; it must not replace the prompt's terminal with a
    // "Nothing to wake." completion.
    const wake = runner.turn({
      type: "wake",
    });

    runner.completeNext("done");
    const [firstTerminal, wakeTerminal] = await Promise.all([first, wake]);

    expect(firstTerminal).toBe(wakeTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(wakeTerminal).toMatchObject({
      type: "complete",
      status: "completed",
      result: "done",
    });
  });

  test("prompts sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "script_step",
      ),
    );

    const prompt = runner.turn({
      type: "prompt",
      message: "question during script",
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("question during script");
    runner.completeNext("answer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("answer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
  });

  test("answers sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "script_step",
      ),
    );

    const answer = runner.turn({
      type: "answer",
      questions: [{ question: "Pick one", options: [{ label: "A" }] }],
      answers: { choice: ["A"] },
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("Here are my answers");
    runner.completeNext("answer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("answer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, answerTerminal] = await Promise.all([turn, answer]);
    expect(turnTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("steer prompts sent during script work run before state-machine continuation", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: scriptThenTerminalDefinition(),
      prompt: "run script flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "script_step",
      ),
    );

    const steer = runner.turn({
      type: "prompt",
      message: "steer during script",
      behavior: "steer",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("steer during script");
    runner.completeNext("steer after script");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "script_step" finished');
    expect(contextText(runner.contexts[2]!)).toContain("steer after script");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, steerTerminal] = await Promise.all([turn, steer]);
    expect(turnTerminal).toBe(steerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("steer replacement during script work follows the replacement state", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: longScriptDefinition(),
      prompt: "run long script flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "script_step",
      ),
    );

    const steer = runner.turn({
      type: "prompt",
      message: "replace the active script",
      behavior: "steer",
    });
    await waitFor(() => runner.contexts.length >= 2);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: {
        kind: "run_state",
        state: "script_step",
        override: { kind: "script", state: { command: "printf '{\"replacement\":true}'" } },
      },
    });
    await waitFor(() => runner.contexts.length >= 3);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, steerTerminal] = await Promise.all([turn, steer]);
    expect(turnTerminal).toBe(steerTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(turnTerminal.state.stateMachine?.terminal).toMatchObject({
      state: "done",
      status: "completed",
    });
    expect(turnTerminal.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({ type: "state_interrupted", state: "script_step" }),
    );
  });

  test("second steer during active state work steers the running parent prompt", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: longScriptDefinition(),
      prompt: "run long script flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "script_step" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "script_step",
      ),
    );

    const firstSteer = runner.turn({
      type: "prompt",
      message: "first steer during script",
      behavior: "steer",
    });
    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("first steer during script");
    expect(runner.pendingStreams).toHaveLength(1);

    const secondSteer = runner.turn({
      type: "prompt",
      message: "second steer during parent prompt",
      behavior: "steer",
    });
    expect(runner.pendingStreams).toHaveLength(1);

    runner.completeNext("first parent steer response");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain("second steer during parent prompt");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: {
        kind: "run_state",
        state: "script_step",
        override: { kind: "script", state: { command: "printf '{\"replacement\":true}'" } },
      },
    });
    await waitFor(() => runner.contexts.length >= 4);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, firstSteerTerminal, secondSteerTerminal] = await Promise.all([
      turn,
      firstSteer,
      secondSteer,
    ]);
    expect(turnTerminal).toBe(firstSteerTerminal);
    expect(turnTerminal).toBe(secondSteerTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
  });

  test("follow-up prompts sent during active poll checks queue until the poll resolves", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "poll_reply",
      ),
    );

    const prompt = runner.turn({
      type: "prompt",
      message: "question during poll",
      behavior: "follow_up",
    });

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(runner.contexts).toHaveLength(1);
    expect(turnTerminal.state.queuedCommands).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("steer prompts sent during poll checks run immediately and return to sleep", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "poll_reply",
      ),
    );

    const steer = runner.turn({
      type: "prompt",
      message: "steer during poll",
      behavior: "steer",
    });

    await waitFor(() => runner.contexts.length >= 2, 100);
    expect(lastUserText(runner.contexts[1]!)).toContain("steer during poll");
    runner.completeNext("poll still waiting after steer");

    const [turnTerminal, steerTerminal] = await Promise.all([turn, steer]);
    expect(turnTerminal).toBe(steerTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("queued wake behind state-machine work rebases onto sleeping poll state", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: immediateUnresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
    });

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(turnTerminal.state.stateMachine?.currentState).toBe("poll_reply");
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("multiple follow-up prompts during active poll checks remain queued in order", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: unresolvedPollDefinition(),
      prompt: "run poll flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "poll_reply",
      ),
    );

    const firstPrompt = runner.turn({
      type: "prompt",
      message: "first question during poll",
      behavior: "follow_up",
    });

    const secondPrompt = runner.turn({
      type: "prompt",
      message: "second question during poll",
      behavior: "follow_up",
    });

    const [turnTerminal, firstTerminal, secondTerminal] = await Promise.all([
      turn,
      firstPrompt,
      secondPrompt,
    ]);
    expect(turnTerminal).toBe(firstTerminal);
    expect(firstTerminal).toBe(secondTerminal);
    expect(turnTerminal.type).toBe("sleep");
    expect(turnTerminal.state.queuedCommands?.map((command) => command.type)).toEqual([
      "prompt",
      "prompt",
    ]);
    expect(turnTerminal.state.followUpQueue).toEqual([
      { message: "first question during poll" },
      { message: "second question during poll" },
    ]);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("resolved polls enqueue state-machine continuation after the mid-poll agent answer", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: resolvedPollDefinition(),
      prompt: "run resolved poll flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "poll_reply" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "poll_reply",
      ),
    );

    const prompt = runner.turn({
      type: "prompt",
      message: "question during resolving poll",
      behavior: "follow_up",
    });

    await waitFor(() => runner.contexts.length >= 2);
    expect(lastUserText(runner.contexts[1]!)).toContain("question during resolving poll");
    await delay(75);
    runner.completeNext("agent saw user before continuation");

    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain('The state "poll_reply" finished');
    expect(contextText(runner.contexts[2]!)).toContain("agent saw user before continuation");
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("sleeping follow-up failure emits system error and resolves to sleep", async () => {
    const { runner, events } = createStreamingRunner();
    const sleeping = {
      ...createStateMachineState("poll_email_reply"),
      status: "sleeping" as const,
    };
    await runner.start({ type: "start", state: sleeping });

    const turn = runner.turn({
      type: "prompt",
      message: "anything new?",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNext("", { error: "model failed" });

    const terminal = await turn;
    expect(terminal.type).toBe("sleep");
    expect(terminal.state.status).toBe("sleeping");
    expect(events).toContainEqual({
      type: "system",
      level: "error",
      message: "model failed",
    });
    expect(
      events.filter((event) => event.type === "complete" && event.status === "failed"),
    ).toEqual([]);
  });

  test("failed active turns emit one failed terminal and drop queued commands", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "start" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
    });

    runner.completeNext("", { error: "model failed" });

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "failed" });
    expect(turnTerminal.type === "complete" ? turnTerminal.result : "").not.toBe(
      "Nothing to wake.",
    );
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("interrupt drops queued work and emits one interrupted terminal", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn: first } = await startTurn(runner, { mode: "agent", prompt: "start" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const followUp = runner.turn({
      type: "prompt",
      message: "queued",
      behavior: "follow_up",
    });
    await waitFor(() => followUpQueueEvents(events).some((queue) => queue[0] === "queued"));
    expect(followUpQueueEvents(events)).toContainEqual(["queued"]);
    runner.interrupt({ type: "interrupt" });
    runner.completeNext("", { error: "aborted" });

    const [firstTerminal, followUpTerminal] = await Promise.all([first, followUp]);
    expect(firstTerminal).toBe(followUpTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(firstTerminal.type).toBe("interrupted");
    expect(messageTexts(firstTerminal.state)).not.toContain("queued");
    expect(followUpQueueEvents(events).at(-1)).toEqual([]);
  });

  test("dispose drops queued work without starting another command", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, { mode: "agent", prompt: "start" });
    await waitFor(() => runner.pendingStreams.length === 1);

    const wake = runner.turn({
      type: "wake",
    });
    void runner.turn({
      type: "prompt",
      message: "queued before dispose",
      behavior: "follow_up",
    });
    await waitFor(() =>
      followUpQueueEvents(events).some((queue) => queue[0] === "queued before dispose"),
    );
    expect(followUpQueueEvents(events)).toContainEqual(["queued before dispose"]);
    await delay(0);
    await runner.dispose();

    runner.completeNext("done");

    const [turnTerminal, wakeTerminal] = await Promise.all([turn, wake]);
    expect(turnTerminal).toBe(wakeTerminal);
    expect(turnTerminal).toMatchObject({ type: "complete", status: "completed" });
    expect(turnTerminal.type === "complete" ? turnTerminal.result : "").not.toBe(
      "Nothing to wake.",
    );
    expect(terminalEvents(events)).toHaveLength(1);
    expect(followUpQueueEvents(events).at(-1)).toEqual([]);
  });

  test("answers during active state-agent work queue through the parent", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: stateAgentDefinition(),
      prompt: "run state-agent flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "state_agent" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "state_agent",
      ),
    );
    await waitFor(() => runner.pendingStreams.length === 1);

    const answer = runner.turn({
      type: "answer",
      questions: [{ question: "State-agent question", options: [{ label: "A" }] }],
      answers: { choice: ["A"] },
      behavior: "follow_up",
    });

    runner.completeNext("state-agent first response");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[2]!)).toContain("Here are my answers");
    runner.completeNext("state-agent answer response");
    await waitFor(() => runner.contexts.length >= 4);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, answerTerminal] = await Promise.all([turn, answer]);
    expect(turnTerminal).toBe(answerTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  test("does not persist active state-agent transcripts before completion", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: stateAgentDefinition(),
      prompt: "run state-agent flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "state_agent" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "state_agent",
      ),
    );
    await waitFor(() => runner.getState()?.stateMachine?.currentState === "state_agent");

    const snapshot = runner.getState();
    expect(snapshot?.stateMachine?.currentState).toBe("state_agent");
    expect(snapshot?.stateMachine?.history.some((event) => event.type === "state_started")).toBe(
      true,
    );

    runner.completeNext("state-agent response");
    await waitFor(() => runner.contexts.length >= 3);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);
    await turn;
  });

  test("reruns state-agent states from fresh transcripts after resume", async () => {
    const { runner } = createStreamingRunner();
    const state: TurnState = {
      status: "running",
      mode: stateAgentDefinition(),
      agent: { status: "running", messages: [] },
      stateMachine: {
        definition: stateAgentDefinition(),
        prompt: "Run state-agent flow.",
        currentState: "interrupted",
        history: [
          { type: "state_started", timestamp: Date.now(), state: "state_agent" },
          { type: "state_interrupted", timestamp: Date.now(), state: "state_agent" },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    await runner.start({ type: "start", state: JSON.parse(JSON.stringify(state)) as TurnState });

    const turn = runner.turn({
      type: "prompt",
      message: "resume parent",
      behavior: "follow_up",
    });
    await waitFor(() => runner.pendingStreams.length === 1);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "state_agent" },
    });
    await waitFor(() => runner.contexts.length >= 2);

    expect(lastUserText(runner.contexts[1]!)).toContain("Ask the state-agent question.");
    expect(contextText(runner.contexts[1]!)).not.toContain("resume parent");
    runner.completeNext("state-agent rerun");
    await waitFor(() => runner.contexts.length >= 3);
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);
    await turn;
  });

  test("prompts during active state-agent work queue for the parent", async () => {
    const { runner, events } = createStreamingRunner();
    const { turn } = await startTurn(runner, {
      mode: stateAgentDefinition(),
      prompt: "run state-agent flow",
    });
    await waitFor(() => runner.pendingStreams.length === 1);

    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "run_state", state: "state_agent" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "state_machine" && event.stateMachine.currentState === "state_agent",
      ),
    );
    await waitFor(() => runner.pendingStreams.length === 1);

    const prompt = runner.turn({
      type: "prompt",
      message: "parent should handle this",
      behavior: "follow_up",
    });

    runner.completeNext("state-agent response");
    await waitFor(() => runner.contexts.length >= 3);
    expect(lastUserText(runner.contexts[1]!)).not.toContain("parent should handle this");
    expect(lastUserText(runner.contexts[2]!)).toContain("parent should handle this");
    runner.completeNext("parent response");

    await waitFor(() => runner.contexts.length >= 4);
    expect(lastUserText(runner.contexts[3]!)).toContain('The state "state_agent" finished');
    runner.completeNextToolCall("select_state_machine_state", {
      decision: { kind: "terminal", state: "done" },
    });
    await ackTerminal(runner);

    const [turnTerminal, promptTerminal] = await Promise.all([turn, prompt]);
    expect(turnTerminal).toBe(promptTerminal);
    expect(terminalEvents(events)).toHaveLength(1);
  });
});

function createStreamingRunner(): { runner: StreamingTurnRunner; events: TurnEvent[] } {
  const runner = new StreamingTurnRunner();
  const events: TurnEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return { runner, events };
}

function terminalEvents(events: TurnEvent[]): TurnTerminalEvent[] {
  return events.filter(
    (event): event is TurnTerminalEvent =>
      event.type === "ask" ||
      event.type === "complete" ||
      event.type === "interrupted" ||
      event.type === "sleep",
  );
}

function followUpQueueEvents(events: TurnEvent[]): string[][] {
  return events
    .filter(
      (event): event is Extract<TurnEvent, { type: "follow_up_queue" }> =>
        event.type === "follow_up_queue",
    )
    .map((event) => event.followUpQueue.map((entry) => entry.message));
}

function messageTexts(state: TurnState): string[] {
  return state.agent.messages.flatMap((message) => {
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    );
  });
}

function contextText(context: Context): string {
  return context.messages
    .map((message) => {
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join("\n");
    })
    .join("\n");
}

function lastUserText(context: Context): string {
  const user = [...context.messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  return contextText({ ...context, messages: [user] });
}

function scriptThenTerminalDefinition(): StateMachineDefinition {
  return {
    name: "script_flow",
    prompt: "Use for script test.",
    states: [
      {
        kind: "script",
        name: "script_step",
        command: "sleep 0.05; printf '{\"scriptDone\":true}'",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function longScriptDefinition(): StateMachineDefinition {
  return {
    name: "long_script_flow",
    prompt: "Use for script replacement test.",
    states: [
      {
        kind: "script",
        name: "script_step",
        command: "sleep 2; printf '{\"scriptDone\":true}'",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function unresolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "poll_flow",
    prompt: "Use for poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        command: "sleep 2; printf '{}'",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function resolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "resolved_poll_flow",
    prompt: "Use for resolved poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        command: 'sleep 0.05; printf \'{"reply":"yes"}\'',
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function immediateUnresolvedPollDefinition(): StateMachineDefinition {
  return {
    name: "immediate_poll_flow",
    prompt: "Use for immediate poll test.",
    states: [
      {
        kind: "poll",
        name: "poll_reply",
        intervalMs: 60_000,
        command: "printf '{}'",
      },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}

function stateAgentDefinition(): StateMachineDefinition {
  return {
    name: "state_agent_flow",
    prompt: "Use for state-agent test.",
    states: [
      { kind: "agent", name: "state_agent", prompt: "Ask the state-agent question." },
      { kind: "terminal", name: "done", status: "completed" },
    ],
  };
}
