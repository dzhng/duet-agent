# Duet CLI — RPC Mode

`duet --rpc` is a bare turn-runner control surface for other coding agents and
automation. It reads newline-delimited JSON `TurnRunnerCommand` values from
stdin and writes newline-delimited `TurnEvent` values to stdout. Each process
runs exactly one turn and exits.

The wire schema is `src/types/protocol.ts`. Treat that file as the source of
truth; this document explains the lifecycle and the few things the transport
layer adds on top.

## Invocation

```sh
duet --rpc \
  [--workdir <path>] \
  [--model <name> | --provider <name>] \
  [--memory-model <name>] \
  [--incognito] \
  [--system-prompt <text>] [--system-prompt-file <path>] \
  [--no-system-prompt-files] \
  [--env-file <path>]
```

- All flags apply to the `TurnRunnerConfig` the runner is constructed with.
  They do not change the wire protocol.
- Session-mode flags (`--resume`, `--resume-history-messages`, a prompt
  argument) are intentionally rejected. RPC mode does not touch
  `SessionManager`, `~/.duet/sessions`, or `state.json`. Persistence policy
  lives with the caller.
- `--incognito` keeps observational memory in-process only. Without it the
  runner writes to its configured memory db (default `~/.duet/memory.db`)
  exactly like the TUI does.
- `--system-prompt-file` defaults to loading a repo-local `AGENTS.md` from
  `--workdir`. Pass `--no-system-prompt-files` to disable, or repeat
  `--system-prompt-file` for multiple files.
- Skills are discovered from `--workdir/.duet/skills`, `--workdir/.agents/skills`,
  and the same directories under `$HOME` by default. Skills appear in the
  runner's system prompt as metadata; the model lazy-loads each
  `SKILL.md` via the `read_skill` tool.

The process writes a one-line banner to **stderr** on start:

```
@duetso/agent 0.1.65 rpc
```

Use it for version-skew detection; consumers should ignore stderr otherwise.
Fatal errors are also written to stderr as `Fatal: <message>\n` and exit 1.

## Wire format

- One JSON value per line, terminated by `\n`. Blank lines are skipped.
- Stdin: `TurnRunnerCommand` (see `src/types/protocol.ts`).
- Stdout: `TurnEvent` (same file).

There is no framing beyond newlines. Embedded `\n` characters inside a JSON
string are valid; just do not pretty-print the JSON — keep each command on a
single line.

## Lifecycle (one turn per process)

1. The caller sends a `start` command. This is **setup, not a turn**: the
   runner loads memory and skills, hydrates from `start.state` if provided,
   and emits a single `turn_started` event with the initial `TurnState`.
2. The caller sends exactly one turn-driving command — `prompt`, `answer`,
   or `wake` — to actually run the turn.
3. The runner streams any number of during-turn events
   (`step`, `todos`, `follow_up_queue`, `state_machine`, `memory`,
   `usage`, `system`).
4. The turn ends with exactly one terminal event:
   `complete`, `ask`, `interrupted`, or `sleep`. Every terminal event carries
   the next `TurnState` snapshot.
5. The process exits cleanly once the terminal event has been written.

```
caller → {"type":"start"}
duet   ← {"type":"turn_started", ...}
caller → {"type":"prompt", "message": "...", "behavior": "follow_up"}
duet   ← {"type":"step", ...}              (zero or more)
duet   ← {"type":"step", ...}
duet   ← {"type":"complete", "status":"completed", "state": {...}, ...}
(process exits)
```

### Multi-turn driving

RPC runs **one turn per process**. To run another turn, spawn a fresh
`duet --rpc` process and replay the previous terminal event's `state` into
the next `start` command:

```jsonc
{ "type": "start", "state": <last terminal event's state> }
```

The runner restores the conversation history, todos, follow-up queue, and
state-machine session from that snapshot. Memory persists separately via the
memory db (or stays in-process when `--incognito` is set).

This design keeps each process stateless from the caller's perspective: you
can pin the conversation to a file, a row in your own database, or anywhere
else convenient.

### Out-of-band commands during a turn

While the turn is running, the caller may send:

- `interrupt` — cancels the active turn. The runner unwinds and emits an
  `interrupted` terminal event.
- `edit_follow_up_queue` — replaces the queued follow-up prompts wholesale.
  The runner mirrors the queue into the active pi agent when possible.

Both are processed concurrently with the turn. They do **not** count as a
turn-driving command, so they cannot start or replace the in-flight turn.

### `prompt.behavior`

Every `prompt` command must set `behavior`:

- `"steer"` — deliver as an interruption/steering message to the running pi
  agent. Use this when the user types a follow-up while work is happening,
  e.g. "actually, skip the migration step."
- `"follow_up"` — queue the prompt until the active turn settles, then
  deliver it as the next user turn.

In a single-turn-per-process model you will normally send the first prompt
with either behavior and let the turn run to completion. `"steer"` matters
when you are sending a second `prompt` mid-turn (allowed in the same way
`interrupt` is — the runner decides routing).

## Multimodal prompts

`TurnPromptCommand.images` and `TurnAnswerCommand.images` carry vision input:

```json
{
  "type": "prompt",
  "message": "Describe this image in one sentence.",
  "behavior": "follow_up",
  "images": [{ "data": "<base64 bytes>", "mimeType": "image/png" }]
}
```

- `data` is **raw base64**, no `data:` URL prefix.
- `mimeType` is the standard `image/png`, `image/jpeg`, etc. — whatever the
  vision-capable model expects.
- Images go through to the parent pi agent as multimodal user content
  alongside `message`. State-machine sub-agents and synthesized answer
  prompts ignore them.

The model must be vision-capable. The default routing (`sonnet-4.6`,
`opus-4.7`, `gpt-5.5`, etc.) supports images; `haiku-4.5` does not — if you
override the model, pick one that does.

## State, memory, AGENTS.md, and skills

- **State**: `TurnState` is fully serializable JSON. Persist whatever the last
  terminal event sent you and feed it back into the next `start.state`.
- **Memory**: the runner owns observational memory regardless of session. With
  `--incognito` it stays in-process; otherwise it writes to the configured
  memory db. The `memory` event type streams observation activity.
- **AGENTS.md / system prompt files**: loaded from `--workdir` by default.
  The model sees them as part of its system prompt. Use
  `--no-system-prompt-files` to skip, or override with `--system-prompt-file`.
- **Skills**: discovered from `--workdir` and `$HOME` by default. Each skill's
  metadata (name, description) appears in the system prompt; the body is
  loaded on-demand by the model via the `read_skill` tool. To bundle skills
  with your tool, drop them under `<workdir>/.duet/skills/<name>/SKILL.md`
  before spawning `duet --rpc`.

## Event types you will see

See `src/types/protocol.ts` for the full discriminated union. The ones a
consumer typically renders or reacts to:

- `turn_started` — initial state; emitted exactly once after `start`.
- `step` — streamed assistant text/reasoning, tool calls, and tool results.
  Each tool call moves through `pending → running → completed | error`.
- `todos` — the model's current todo list.
- `state_machine` — current state name when running a state machine.
- `memory` — observational memory writes (extraction / reflection activity).
- `usage` — running turn-aggregate token accounting (`usage`) plus the latest parent context-window snapshot (`effectiveContextWindow`, `contextWindowUsage` breakdown of `systemPrompt`, `messages`, `localMemory`, `globalMemory`). Emitted after every parent assistant message and after every state-agent finishes, so consumers can render cost ticks mid-turn.
- `complete | ask | interrupted | sleep` — terminal events. Always include
  the updated `state`. When at least one assistant message has been
  recorded this turn, terminals additionally carry the same `usage` /
  `effectiveContextWindow` / `contextWindowUsage` fields as the `usage`
  event, so a consumer that only reads terminals can still recover the
  final aggregate. `ask` requires the caller to follow up with
  `{ "type": "answer", ... }`; `sleep` carries a `wakeAt` epoch ms; the
  caller is responsible for scheduling a wake.

## Error model

- Malformed stdin lines (invalid JSON, missing `type` field) exit 1 with a
  `Fatal:` message on stderr before any turn runs.
- Sending a non-`start` first command, two `start` commands, or two
  turn-driving commands also exits 1.
- Runtime errors during a turn (model failures, tool errors) come back as a
  `complete` terminal event with `status: "failed"` and `error: "..."`. The
  process still exits 0 in that case because the protocol completed cleanly;
  inspect the terminal event to surface the failure.
- Closing stdin before the turn-driving command arrives is a clean exit
  (exit 0, no terminal event).

## Minimal example

```sh
(
  printf '%s\n' '{"type":"start"}'
  printf '%s\n' '{"type":"prompt","message":"What is 2+2? Reply with one number.","behavior":"follow_up"}'
) | duet --rpc --workdir /tmp --incognito --model sonnet-4.6
```

Read the JSONL on stdout; the last event with type `complete` carries the
final answer and the `state` you would replay for a follow-up turn.
