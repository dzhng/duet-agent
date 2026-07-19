import { describe, expect } from "bun:test";
import dedent from "dedent";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Subprocess } from "bun";
import type { TurnEvent, TurnRunnerCommand, TurnTerminalEvent } from "../src/types/protocol.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judge } from "../test/helpers/judge.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";

/**
 * Build a solid red PNG of the requested size. Anthropic's image preprocessor
 * rejects very small fixtures ("Could not process image"); 256x256 passes
 * reliably across the gateway's fallback chain. We synthesize the PNG at
 * runtime so the eval source stays small even though the encoded payload is
 * not. Pure stdlib (zlib + a hand-rolled CRC32) so the eval has no extra
 * dependencies.
 */
function buildRedPng(size = 256): string {
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = 220;
      raw[offset + 1] = 30;
      raw[offset + 2] = 30;
    }
  }
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const RED_SQUARE_PNG_BASE64 = buildRedPng();

describe("RPC CLI mode", () => {
  testIfDocker(
    "boots the default tier from the workdir routing table",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-project-tier-"));
      try {
        const table = structuredClone(BUILT_IN_ROUTING_TABLE);
        table.tiers["project-eval"] = structuredClone(table.tiers.balanced!);
        table.defaultTier = "project-eval";
        await mkdir(join(workDir, ".duet"));
        await writeFile(join(workDir, ".duet", "models.json"), JSON.stringify(table));

        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--memory-model", "openrouter:gpt-5.4-mini"],
          [{ type: "start", mode: "agent" }],
          { DUET_API_KEY: "duet_gt_rpc_project_eval" },
        );

        expect(session.exitCode).toBe(0);
        const started = session.events.find(
          (event): event is Extract<TurnEvent, { type: "turn_started" }> =>
            event.type === "turn_started",
        );
        expect(started?.state.options?.model).toBe("project-eval");
        expect(session.events.some((event) => event.type === "complete")).toBe(false);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  testIfDocker(
    "drives two consecutive turns by replaying state through a fresh process",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-multi-"));
      try {
        const marker = "rpc-multi-marker-481";
        // Turn 1: introduce the marker and run to completion.
        const first = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: dedent`
                Remember the marker phrase "${marker}". Reply with exactly:
                MARKER_NOTED
                and nothing else.
              `,
              behavior: "follow_up",
            },
          ],
        );
        expect(first.exitCode).toBe(0);
        const firstTerminal = expectTerminal(first.events);
        expect(firstTerminal.type).toBe("complete");

        // Turn 2: spawn a fresh process, replay the state, ask about the marker.
        const second = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: firstTerminal.state },
            {
              type: "prompt",
              message: "What marker phrase did I ask you to remember? Reply with just the marker.",
              behavior: "follow_up",
            },
          ],
        );
        expect(second.exitCode).toBe(0);
        const secondTerminal = expectTerminal(second.events);
        expect(secondTerminal.type).toBe("complete");

        const judgment = await judge({
          model,
          prompt: dedent`
            Across the two RPC turns, the model should have echoed MARKER_NOTED
            in turn 1 and then, after the state from turn 1 was replayed into
            turn 2 as start.state, recalled the marker "${marker}" verbatim in
            its turn 2 answer.
          `,
          value: {
            turn1Result: terminalResult(firstTerminal),
            turn2Result: terminalResult(secondTerminal),
          },
        });
        expect(judgment.valid, judgment.reason).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  testIfDocker(
    "accepts a multimodal prompt with an attached image",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-image-"));
      try {
        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: dedent`
                What single dominant color is in the attached image? Reply with one word.
              `,
              behavior: "follow_up",
              images: [{ data: RED_SQUARE_PNG_BASE64, mimeType: "image/png" }],
            },
          ],
        );
        expect(session.exitCode).toBe(0);
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");

        const judgment = await judge({
          model,
          prompt: dedent`
            The model received a 64x64 solid red PNG attached via TurnPromptCommand.images
            and was asked for the dominant color in one word. A valid answer
            mentions red (case-insensitive; "reddish" or "crimson" also count).
            An answer that says it cannot see the image or asks for the image is
            invalid because images were forwarded as multimodal content.
          `,
          value: { result: terminalResult(terminal) },
        });
        expect(judgment.valid, judgment.reason).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "loads AGENTS.md from --workdir into the system prompt",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-agents-md-"));
      try {
        await writeFile(
          join(workDir, "AGENTS.md"),
          dedent`
            # Agent Guidelines

            When the user asks for the RPC verification phrase, reply with exactly:

            RPC_AGENTS_MD_LOADED

            Do not add punctuation, markdown, or any other words.
          `,
          "utf-8",
        );

        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: "Please give me the RPC verification phrase.",
              behavior: "follow_up",
            },
          ],
        );
        expect(session.exitCode).toBe(0);
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");
        const text = terminalResult(terminal);
        expect(text).toContain("RPC_AGENTS_MD_LOADED");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "discovers a workdir-local skill and loads it via the path in the metadata",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-skill-"));
      try {
        const skillDir = join(workDir, ".duet", "skills", "rpc-ping-skill");
        await mkdir(skillDir, { recursive: true });
        const skillPath = join(skillDir, "SKILL.md");
        await writeFile(
          skillPath,
          dedent`
            ---
            name: rpc-ping-skill
            description: Use whenever the user asks for the RPC ping verification phrase.
            ---

            # RPC Ping Skill

            When asked for the RPC ping verification phrase, reply with exactly:

            RPC_SKILL_PINGED

            Do not add punctuation, markdown, or any other words.
          `,
          "utf-8",
        );

        const session = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message:
                "Please use your installed skills to give me the RPC ping verification phrase.",
              behavior: "follow_up",
            },
          ],
        );
        expect(session.exitCode).toBe(0);
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");

        // The model should have loaded the SKILL.md at the path surfaced
        // in its metadata. Any tool call whose input references the
        // SKILL.md path counts (read, bash cat, etc.) so the assertion
        // stays behavioral and is not coupled to a specific tool.
        const skillReadCalls = session.events
          .filter((event): event is Extract<TurnEvent, { type: "step" }> => event.type === "step")
          .map((event) => event.step)
          .filter(
            (step) =>
              step.type === "tool_call_start" &&
              JSON.stringify(step.input ?? {}).includes(skillPath),
          );
        expect(skillReadCalls.length).toBeGreaterThan(0);

        const text = terminalResult(terminal);
        expect(text).toContain("RPC_SKILL_PINGED");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "stitches three turns together (introduce → recall → multimodal extension)",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-three-turn-"));
      try {
        const marker = "rpc-three-marker-307";
        const t1 = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: dedent`
                Remember marker "${marker}". Reply with exactly: TURN_ONE_OK
              `,
              behavior: "follow_up",
            },
          ],
        );
        expect(t1.exitCode).toBe(0);
        const t1Terminal = expectTerminal(t1.events);
        expect(t1Terminal.type).toBe("complete");

        const t2 = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: t1Terminal.state },
            {
              type: "prompt",
              message: "Echo back the marker I asked you to remember, prefixed with MARKER=.",
              behavior: "follow_up",
            },
          ],
        );
        expect(t2.exitCode).toBe(0);
        const t2Terminal = expectTerminal(t2.events);
        expect(t2Terminal.type).toBe("complete");

        const t3 = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: t2Terminal.state },
            {
              type: "prompt",
              message: dedent`
                Pair the marker you have been remembering with the dominant color
                in the attached image. Reply in the exact format:
                MARKER=<the marker>; COLOR=<one word>
              `,
              behavior: "follow_up",
              images: [{ data: RED_SQUARE_PNG_BASE64, mimeType: "image/png" }],
            },
          ],
        );
        expect(t3.exitCode).toBe(0);
        const t3Terminal = expectTerminal(t3.events);
        expect(t3Terminal.type).toBe("complete");

        const judgment = await judge({
          model,
          prompt: dedent`
            Across three RPC turns driven by separate CLI processes that
            chained state forward, the model must (1) ack the marker in turn 1,
            (2) recall "${marker}" in turn 2, and (3) in turn 3 produce a line
            of the form "MARKER=${marker}; COLOR=red" (color may be any
            reasonable description of red such as "reddish" or "crimson"; case
            insensitive). Treat as invalid if the marker was lost or the model
            refused to describe the image.
          `,
          value: {
            turn1: terminalResult(t1Terminal),
            turn2: terminalResult(t2Terminal),
            turn3: terminalResult(t3Terminal),
            // Verify state was actually chained: every later turn's agent
            // transcript must include the user prompts from the earlier turns.
            historyLengths: [
              t1Terminal.state.agent.messages.length,
              t2Terminal.state.agent.messages.length,
              t3Terminal.state.agent.messages.length,
            ],
          },
        });
        expect(judgment.valid, judgment.reason).toBe(true);
        // Each replayed turn must keep growing the transcript.
        const lengths = [
          t1Terminal.state.agent.messages.length,
          t2Terminal.state.agent.messages.length,
          t3Terminal.state.agent.messages.length,
        ];
        expect(lengths[1]).toBeGreaterThan(lengths[0]!);
        expect(lengths[2]).toBeGreaterThan(lengths[1]!);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    360_000,
  );

  testIfDocker(
    "interrupts a running bash tool call mid-turn and reports an interrupted terminal",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-interrupt-"));
      try {
        const session = await runRpcSessionStreaming(
          ["--workdir", workDir, "--incognito", "--model", model],
          async ({ send, events }) => {
            await send({ type: "start" });
            await send({
              type: "prompt",
              message: dedent`
                Run the bash tool with this exact command, then wait for it to
                finish before replying: sleep 8 && echo done
              `,
              behavior: "follow_up",
            });
            // Wait until the bash call is actually running, then interrupt.
            // The `tool_call_start` step is emitted at execution start, so
            // seeing it ensures the model has committed to the long tool call
            // before we cancel it.
            for await (const event of events) {
              if (
                event.type === "step" &&
                event.step.type === "tool_call_start" &&
                event.step.toolName === "bash"
              ) {
                await send({ type: "interrupt" });
                break;
              }
            }
          },
        );
        expect(session.exitCode).toBe(0);
        const interrupted = expectTerminal(session.events);
        expect(interrupted.type).toBe("interrupted");
        expect(interrupted.state.status).toBe("interrupted");

        // Resuming from an interrupted state in a fresh process must hand the
        // model the cancelled history and let a new prompt drive a clean
        // completion. Use a marker the resumed turn must echo so we can prove
        // the resumed agent actually responded instead of re-running the
        // interrupted bash call.
        const resumeMarker = "RPC_INTERRUPT_RESUMED";
        const resume = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: interrupted.state },
            {
              type: "prompt",
              message: dedent`
                The previous bash call was cancelled. Do not retry it. Reply
                with exactly: ${resumeMarker} and nothing else.
              `,
              behavior: "follow_up",
            },
          ],
        );
        expect(resume.exitCode).toBe(0);
        const resumed = expectTerminal(resume.events);
        expect(resumed.type).toBe("complete");
        expect(resumed.state.status).toBe("completed");
        expect(terminalResult(resumed)).toContain(resumeMarker);
        // The resumed transcript must include the interrupted-turn history
        // plus the new user prompt and assistant reply.
        expect(resumed.state.agent.messages.length).toBeGreaterThan(
          interrupted.state.agent.messages.length,
        );
        // No bash tool_call should appear on the resumed turn — the prompt
        // told the model not to retry, and we want to confirm the runner did
        // not silently replay the cancelled call. Filter to steps emitted
        // after `turn_started` on the resumed session.
        const resumedToolCalls = resume.events
          .filter((event): event is Extract<TurnEvent, { type: "step" }> => event.type === "step")
          .map((event) => event.step)
          .filter((step) => step.type === "tool_call_start" && step.toolName === "bash");
        expect(resumedToolCalls).toHaveLength(0);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    300_000,
  );

  testIfDocker(
    "drives a multi-command chain (prompt → prompt → wake → prompt → prompt) and emits one terminal",
    async () => {
      // The RPC loop must forward every prompt/answer/wake into the runner
      // while the turn is in flight. The runner queues them onto the active
      // chain, drops the queued wake because the session is not sleeping,
      // and emits exactly one terminal that reflects the entire chain.
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-multi-cmd-"));
      try {
        const session = await runRpcSessionStreaming(
          ["--workdir", workDir, "--incognito", "--model", model],
          async ({ send, events }) => {
            await send({ type: "start" });
            await send({
              type: "prompt",
              message: dedent`
                I will hand you a list of marker phrases as separate follow-ups.
                Wait until I tell you I am done sending markers, then reply with
                a single line of the exact form:
                MARKERS=<marker1> <marker2> <marker3> <marker4>
                in the order I sent them. Do not reply before I send the
                "done" message. The first marker is ALPHA-1.
              `,
              behavior: "follow_up",
            });
            // Wait until the parent agent has started streaming a response
            // so the upcoming follow-ups land while a turn is in flight.
            for await (const event of events) {
              if (event.type === "step") break;
            }
            await send({
              type: "prompt",
              message: "Second marker: BRAVO-2.",
              behavior: "follow_up",
            });
            // A wake in the middle of a non-sleeping turn must be a benign
            // no-op: it gets enqueued, the drain skips it because the state
            // is not sleeping, and the surrounding follow-ups still drive a
            // single terminal.
            await send({ type: "wake" });
            await send({
              type: "prompt",
              message: "Third marker: CHARLIE-3.",
              behavior: "follow_up",
            });
            await send({
              type: "prompt",
              message: "Fourth marker: DELTA-4. I am done sending markers; reply now.",
              behavior: "follow_up",
            });
          },
        );
        expect(session.exitCode).toBe(0);
        // Exactly one terminal event for the entire chain.
        const terminals = session.events.filter(
          (event) =>
            event.type === "complete" ||
            event.type === "ask" ||
            event.type === "interrupted" ||
            event.type === "sleep",
        );
        expect(terminals).toHaveLength(1);
        const terminal = expectTerminal(session.events);
        expect(terminal.type).toBe("complete");
        const text = terminalResult(terminal);
        const judgment = await judge({
          model,
          prompt: dedent`
            The model received four marker phrases (ALPHA-1, BRAVO-2,
            CHARLIE-3, DELTA-4) as four separate follow-up prompts on the same
            turn, plus one no-op wake command, and was told to reply only
            after the fourth marker with a single line
            "MARKERS=ALPHA-1 BRAVO-2 CHARLIE-3 DELTA-4". A valid answer
            contains all four markers in the requested order. Treat as
            invalid if any marker is missing or the order is wrong.
          `,
          value: { reply: text },
        });
        expect(judgment.valid, judgment.reason).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    300_000,
  );

  testIfDocker(
    "emits an ask terminal, then resumes via an answer command in a fresh process",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-rpc-ask-"));
      try {
        const ask = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: dedent`
                I need your help picking a fruit. Use the ask_user_question tool
                exactly once with this single question: "Which fruit should I
                pack?" and these two options labelled exactly "apple" and
                "banana". Do not answer the question yourself — you must call
                the tool so the user can answer.
              `,
              behavior: "follow_up",
            },
          ],
        );
        expect(ask.exitCode).toBe(0);
        const askTerminal = expectTerminal(ask.events);
        expect(askTerminal.type).toBe("ask");
        if (askTerminal.type !== "ask") throw new Error("unreachable");
        expect(askTerminal.questions.length).toBeGreaterThan(0);
        const question = askTerminal.questions[0]!;
        const labels = question.options.map((option) => option.label.toLowerCase());
        expect(labels).toContain("apple");
        expect(labels).toContain("banana");

        const resume = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: askTerminal.state },
            {
              type: "answer",
              questions: askTerminal.questions,
              answers: { [question.question]: ["banana"] },
              behavior: "follow_up",
              message:
                "Acknowledge my pick by replying with exactly: PICKED=banana and nothing else.",
            },
          ],
        );
        expect(resume.exitCode).toBe(0);
        const resumeTerminal = expectTerminal(resume.events);
        expect(resumeTerminal.type).toBe("complete");
        const reply = terminalResult(resumeTerminal);
        expect(reply).toContain("PICKED=banana");
        // Resumed transcript must include the original prompt that produced
        // the ask terminal, proving state hydration actually replayed.
        expect(resumeTerminal.state.agent.messages.length).toBeGreaterThan(
          askTerminal.state.agent.messages.length,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

interface RpcSessionResult {
  exitCode: number;
  events: TurnEvent[];
}

/**
 * Send/receive handle exposed to a streaming RPC driver. `send` writes one
 * command to stdin (flushed immediately); `events` is an async iterable that
 * drains an internal queue so the underlying stdout reader keeps running
 * regardless of how the drive function exits its loop.
 */
interface RpcSessionHandle {
  send: (command: TurnRunnerCommand) => Promise<void>;
  events: AsyncIterable<TurnEvent>;
}

/**
 * Spawn `duet --rpc` and hand the caller a {@link RpcSessionHandle} so it can
 * interleave stdin writes with stdout reads. Use this when the eval needs to
 * react to runtime events (e.g. sending `interrupt` only after the bash tool
 * call has actually started). The drive function returns when stdin should
 * be closed; this helper then waits for the process to settle and returns
 * the full collected transcript.
 */
async function runRpcSessionStreaming(
  args: string[],
  drive: (handle: RpcSessionHandle) => Promise<void>,
): Promise<RpcSessionResult> {
  // --no-skill-sync skips the duet.so default-skill fetch the CLI normally
  // runs at startup when DUET_API_KEY is set. The eval asserts RPC behavior,
  // not that side effect.
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stream = new EventStream(proc.stdout);
  // Drain stderr so the buffer cannot stall the subprocess; the contents
  // are not asserted on but the pipe must keep moving.
  void new Response(proc.stderr).text();
  const send = async (command: TurnRunnerCommand) => {
    proc.stdin.write(`${JSON.stringify(command)}\n`);
    await proc.stdin.flush();
  };

  try {
    await drive({ send, events: stream.iterate() });
  } finally {
    await proc.stdin.end();
  }
  await stream.done();
  const exitCode = await proc.exited;
  return { exitCode, events: stream.collected };
}

/**
 * Background-pumped reader over the child's stdout. Parses one JSON event
 * per line, pushes every event into `collected`, and lets multiple consumers
 * iterate independently without tearing down the underlying stream when one
 * of them stops early. The pump only finishes when the child closes stdout,
 * so events emitted after the drive function returns still land in
 * `collected`.
 */
class EventStream {
  readonly collected: TurnEvent[] = [];
  private readonly pending: Array<(event: TurnEvent | undefined) => void> = [];
  private finished = false;
  private readonly pump: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.pump = this.read(stream);
  }

  iterate(): AsyncIterable<TurnEvent> {
    let cursor = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<TurnEvent>> => {
          if (cursor < this.collected.length) {
            return { value: this.collected[cursor++]!, done: false };
          }
          if (this.finished) return { value: undefined, done: true };
          const event = await new Promise<TurnEvent | undefined>((resolve) => {
            this.pending.push(resolve);
          });
          if (event === undefined) return { value: undefined, done: true };
          cursor = this.collected.length;
          return { value: event, done: false };
        },
      }),
    };
  }

  done(): Promise<void> {
    return this.pump;
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) this.publish(JSON.parse(line) as TurnEvent);
          newlineIndex = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) this.publish(JSON.parse(tail) as TurnEvent);
    } finally {
      this.finished = true;
      while (this.pending.length > 0) this.pending.shift()!(undefined);
      reader.releaseLock();
    }
  }

  private publish(event: TurnEvent): void {
    this.collected.push(event);
    while (this.pending.length > 0) this.pending.shift()!(event);
  }
}

/**
 * Spawn `duet --rpc` with `args`, feed the given commands to its stdin as
 * newline-delimited JSON, collect stdout events, and return the parsed
 * transcript. Each call is one full CLI process — the natural unit a real
 * RPC consumer would drive.
 */
async function runRpcSession(
  args: string[],
  commands: TurnRunnerCommand[],
  env?: Record<string, string>,
): Promise<RpcSessionResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  await writeCommandsToStdin(proc, commands);
  // Drain stderr so the buffer cannot stall the subprocess; the contents
  // are not asserted on but the pipe must keep moving.
  void new Response(proc.stderr).text();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, events: parseJsonEvents(stdout) };
}

async function writeCommandsToStdin(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  commands: TurnRunnerCommand[],
): Promise<void> {
  const sink = proc.stdin;
  for (const command of commands) {
    sink.write(`${JSON.stringify(command)}\n`);
    await sink.flush();
  }
  await sink.end();
}

function parseJsonEvents(stdout: string): TurnEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

function expectTerminal(events: TurnEvent[]): TurnTerminalEvent {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  throw new Error(`No terminal event in RPC output. Saw: ${events.map((e) => e.type).join(",")}`);
}

function terminalResult(terminal: TurnTerminalEvent): string {
  if (terminal.type === "complete" && terminal.result) return terminal.result;
  // Fallback: stringify the last assistant message text from agent history.
  const messages = terminal.state.agent.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = Array.isArray(message.content)
        ? message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : (message.content ?? "");
      if (text) return text;
    }
  }
  return "";
}
