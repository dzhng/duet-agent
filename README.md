# duet-agent

An opinionated, full-stack agent turn runner. Native multimodal memory. Native interrupts. Multi-agent by default. Serverless-friendly: every turn rehydrates from on-disk state, so a session can pause for minutes or months and resume in a fresh sandbox.

**No MCP. Everything is files and CLI.**

## Why another agent framework?

Existing agent turn runners treat tools and memories as pluggable modules. This makes them flexible but fundamentally disconnected — memory is an afterthought.

duet-agent takes the opposite approach: **memory is woven into the core architecture.** Observations are recorded as the agent works, persisted across processes, and reflected when context grows; the runner cannot run without them. Interrupts are handled by the underlying pi agent runtime, so the turn runner does not need its own interrupt bus.

## Architecture

The diagram below walks through a realistic agent-routed state machine: outbound conference
outreach. The user prompt enters the `TurnRunner`, the runner agent picks the next state based on
prompt, history, and available state definitions, and the state machine drives the business process
until it hits a terminal state. The same definition can start in the middle — for example, the
runner can skip straight to `wait_for_reply` if the user says “I already emailed them”.

```mermaid
stateDiagram-v2
  direction TB

  [*] --> Classify : user prompt
  Classify --> AgentMode : one-off task
  Classify --> Outreach : matches a state machine

  AgentMode --> [*] : answer / edits

  state Outreach {
    direction TB
    [*] --> research_prospect

    research_prospect : research_prospect (agent)\nweb + notes lookup
    draft_email       : draft_email (agent)\nwrite first-touch email
    send_email        : send_email (script)\nbash: gmail send
    wait_for_reply    : wait_for_reply (poll)\nevery 6h: check inbox
    schedule_meeting  : schedule_meeting (script)\nbash: calendly create
    meeting_booked    : meeting_booked (terminal: completed)
    not_interested    : not_interested (terminal: completed)
    no_response       : no_response (terminal: cancelled)

    research_prospect --> draft_email     : enough signal
    research_prospect --> not_interested  : disqualified
    draft_email       --> send_email
    send_email        --> wait_for_reply
    wait_for_reply    --> schedule_meeting : positive reply
    wait_for_reply    --> not_interested   : declined
    wait_for_reply    --> no_response      : 14d timeout
    schedule_meeting  --> meeting_booked
  }

  Outreach --> [*]
```

Each state is one of the four kinds the runner understands:

- **agent** states run a sub-agent with a prompt, optional system prompt, and optional skill allowlist.
- **script** states shell out (`bash`, `curl`, CLIs) for anything with an API.
- **poll** states wait on an external signal by running one script check per interval, or by using a timer poll for pure delays.
- **terminal** states record a business outcome (`completed`, `cancelled`, `failed`).

Observational memory, pi coding tools, and guardrails sit underneath every state transition; they
are not states themselves.

## Key Differentiators

### Native Multimodal Memory

Memory is first-class. The default `MemoryStore` is in-memory and emits observation events; optional PGlite storage hydrates and persists durable observations outside the turn runner session.

The memory model follows observational memory: turn runner session messages are observed into durable text observations, and a reflector condenses observations when they grow too large. Observations are scoped as `session` or `resource`.

Observation is multimodal. When messages contain images, the observer inspects them directly and records visual details, user-visible text, UI state, diagrams, and errors as text observations. The agent keeps continuity over screenshots, scanned documents, and other image attachments without re-attaching the original bytes on every turn.

### Pi Coding Tools

Sub-agents use the default tools from `@earendil-works/pi-coding-agent`: read, bash, edit, and write. The turn runner supplies a working directory and can restrict which skills are injected into a state-machine agent state; it does not wrap those tools in a second sandbox abstraction.

### Native Interrupts

Interrupt behavior comes from the underlying pi agent runtime. A user can send a message while a pi session is running, and the runtime can handle it as an interruption or as a follow-up. duet-agent does not add a second interrupt bus on top.

### Multi-Agent by Default

The turn runner can delegate durable process steps into agent states. Agent states are not pre-built classes; they are state-machine states with prompts, optional system prompts, and optional skill allowlists.

### Serverless- And Sandbox-Friendly

The turn runner is stateless across process boundaries. `TurnState` is the only thing that needs to survive: `SessionManager` writes it to `~/.duet/sessions/<id>/state.json` after every terminal event, and durable observations live in PGlite at `~/.duet/memory.db`. A new process — including a fresh serverless invocation, a new sandbox container, or a different machine — can resume a session by pointing at the same state directory and calling `runner.start({ state: savedState })`.

This makes long-running sessions practical. A state machine can sit in `wait_for_reply` for weeks, woken by a cron-driven `wake` command, without keeping a process alive between polls. Sessions that span months — outbound outreach loops, slow build-and-review cycles, scheduled retries — work the same way as one-shot turns: load state, run a turn, persist state, exit.

### Three Execution Modes

The turn runner has three top-level modes:

- `agent`: handle the prompt as a normal agent session. This is for one-off tasks, coding requests, reviews, research, and anything that can complete in the current session.
- `state_machine`: route the prompt into an agent-routed state machine. This is for long-running business processes with durable state, waits, and terminal business outcomes.
- `auto`: let the turn runner classify the prompt and choose either `agent` or `state_machine`.

Normal agent mode handles immediate work; state-machine mode handles business processes that may pause, resume, wait on external systems, or start in the middle based on the user's prompt. In `auto`, the runner classifies the prompt and routes to whichever fits.

### Agent-Routed State Machines

duet-agent is exploring long-running agent-routed state machines for business processes like outbound sales, conference outreach, and development loops. The design goal is **not** to become a workflow engine like Temporal, Airflow, or GitHub Actions.

Instead, state machines are agent-routed. A state-machine definition describes the available business states: agent states, shell-script states, poll states, and terminal states. The runner keeps the state-machine system prompt cache-friendly by including only stable routing instructions plus the original prompt and available state definitions. Current state and history stay in the parent agent conversation, where state transitions, script results, poll results, and user follow-ups are already recorded.

The state machine is higher level than task execution. It tracks one current business state at a time. If a state needs fan-out, parallelism, or a task-level workflow, that belongs inside an agent or script state. The agent can execute a complex workflow internally; the state machine only records the business transition before and after that state.

This keeps state machines flexible enough to start in the middle. For example, a user can say: "prospect person X, I've already sent email, just wait for response." The same outreach state machine can skip research and email sending, then choose the wait-for-response state because the runner agent understands the existing context.

External integrations stay simple: anything with an API or CLI is a script state or script poll. Timer polls cover pure delays such as "wait before retry." Email, GitHub, Calendly, CRM systems, and webhooks do not need first-class engine concepts. If the state machine can tolerate a few minutes of polling delay, a bash script is enough.

What this is not:

- Not a deterministic DAG scheduler.
- Not a low-level durable execution runtime.
- Not a workflow service with queues, workers, locks, and retries as the main abstraction.
- Not a replacement for infrastructure workflow engines when exact-once execution or strict SLAs matter.

The turn runner should provide enough structure for an agent to make good process decisions, while leaving hard operational guarantees to external systems.

### Optional Guardrails

Pattern-based (fast, regex) and semantic (LLM-evaluated) guardrails compose into a firewall. Every bash command and file write can be checked before execution.

## CLI Install

The CLI runs on Bun because OpenTUI is Bun-native. Install Bun first if it is not already available:

```bash
curl -fsSL https://bun.sh/install | bash
```

Install the CLI globally to make the `duet` command available on your PATH:

```bash
bun add --global @duetso/agent
```

You can also install it globally with another package manager:

```bash
npm install --global @duetso/agent
pnpm add --global @duetso/agent
yarn global add @duetso/agent
```

Upgrade an existing global installation:

```bash
duet upgrade
```

## SDK Install

Install the package as a dependency when you want to use the turn runner from TypeScript or JavaScript:

```bash
npm install @duetso/agent
```

## Development

This repo uses Bun for package management, Husky for pre-commit checks, and Docker for functional tests.

```bash
bun install
bun run setup  # install/start Docker on macOS or Linux if needed
bun run check-types
bun run lint
bun run eval   # runs live evals inside Docker
bun run test   # runs the test suite inside Docker
```

Use `bun run test` and `bun run eval`, not raw `bun test`, as the source of truth. File-writing tests and evals run in Docker so focused host runs cannot create `.duet`, PGlite databases, or home-directory skill fixtures in the checkout.

The pre-commit hook runs `format`, `check-types`, and `lint`.

## CLI Quick Start

Set a provider API key in the environment or in `<workdir>/.env`, then run `duet` from any project directory. When `--model` is omitted, the CLI infers a default from the configured provider: Anthropic, AI Gateway, and OpenRouter use Opus 4.7; OpenAI uses GPT-5.5.

```bash
export ANTHROPIC_API_KEY=sk-...

# Start a session
duet "build a REST API with Express"

# Open an interactive session without an initial prompt
duet

# With options
duet -m anthropic:claude-opus-4-7 --workdir ./my-project "refactor the auth module"

# With a custom observational memory model
duet --memory-model anthropic:claude-sonnet-4-6 "summarize this repo"

# With additional system instructions
duet --system-prompt "Prefer concise answers." "review this repo"

# Override the default AGENTS.md system prompt file
duet --system-prompt-file TEAM.md "review this repo"

# Disable system prompt file loading
duet --no-system-prompt-files "review this repo"

# Resume a saved session
duet --resume session_abc123 --workdir ./my-project

# List installed skills (project + user scope)
duet skills

# Through Vercel AI Gateway
export AI_GATEWAY_API_KEY=...
duet -m vercel-ai-gateway:anthropic/claude-opus-4.7 "review this repo"
```

For local development from a checkout, use the package script:

```bash
bun run cli -- "build a REST API with Express"
```

## SDK Quick Start

```typescript
import { TurnRunner } from "@duetso/agent";

const turnRunner = new TurnRunner({
  model: "anthropic:claude-opus-4-7",
  cwd: process.cwd(),
  mode: "auto",
});

// `start` is setup-only: loads skills and memory, emits `turn_started`, runs no agent work.
await turnRunner.start({ mode: "auto" });

const terminal = await turnRunner.turn({
  type: "prompt",
  message: "Build a todo app with React and TypeScript",
  behavior: "follow_up",
});
```

`TurnRunner.turn()` is the concurrency boundary. Callers may call it repeatedly
while work is active; the runner folds active `prompt` and `answer` commands
back into the active pi agent as `steer` or `follow_up`, queues wakes and other
work it cannot absorb immediately, and emits one terminal event when the whole
active work chain is done. The parent runner transcript stays linear: state
machine continuations, script results, poll results, and user follow-ups rejoin
the parent agent rather than creating separate conversation branches.

## Memory And Persistence

The turn runner holds its own `MemoryStore` in memory and emits observation events as work happens. Persistence is a separate layer: `SessionManager` writes session snapshots under `~/.duet/sessions` after every terminal event and mirrors observations into a PGlite database at `~/.duet/memory.db`. Pass `memoryDbPath: false` to keep observational memory in process only, or provide `memoryDbPath` for a custom database location.

```typescript
import { SessionManager } from "@duetso/agent";

const manager = new SessionManager({
  model: "anthropic:claude-opus-4-7",
});
```

The memory module hydrates durable observations from an embedded Postgres database powered by PGlite before the first turn and writes observation updates back as memory changes. Raw conversation messages stay in `TurnState.agent.messages`; memory persistence stores only derived observations/reflections.

You can also resume directly from saved state. The runner owns state
internally after `start`, so resumed state is handed in through the start
command and later turns just send prompts:

```typescript
await turnRunner.start({ state: savedState });

const terminal = await turnRunner.turn({
  type: "prompt",
  message: "Continue the previous goal",
  behavior: "follow_up",
});
```

Resume continues turn runner session state, not an in-flight model/tool call. Any `in_progress` todo is retried from `pending`.

Observational memory is enabled by default with thresholds tuned for modern 200k-token model windows:

- Raw messages are observed around `150_000` tokens so exact transcript context and prompt caching are used before compaction.
- Observation logs are reflected around `90_000` tokens, targeting about `65_000` tokens after reflection.
- Raw-tail retention keeps about `40_000` exact message tokens after observation activation.
- Observation context is injected as reminder messages; replacing raw context with observations/reflections is the compaction path.

## Skills

Skills are loaded from `<cwd>/.duet/skills`, `<cwd>/.agents/skills`, `~/.duet/skills`, and `~/.agents/skills` by default, using `@earendil-works/pi-coding-agent`'s skill loader. The turn runner injects every loaded skill's description and instructions into the agent system prompt.

After `start`, the runner exposes what it discovered:

- `getSkills()` returns the loaded skills, including YAML frontmatter descriptions such as block scalars.
- `getResolvedAgentFiles()` returns the system-prompt files (e.g. `AGENTS.md`) found on disk for the session.
- `getSkillCollisions()` returns name collisions across skill scopes so a CLI or UI can warn about ambiguous skills.

## Guardrails

The turn runner installs its default safety checks internally. Add extra guardrail config objects when a deployment needs stricter local policy.

```typescript
const turnRunner = new TurnRunner({
  // ...
  guardrails: [
    {
      kind: "pattern",
      rules: [
        { pattern: /production-db/i, action: "warn", reason: "Production database mentioned" },
      ],
    },
    {
      kind: "semantic",
      model: getModel("anthropic", "claude-haiku-4-5"),
      policy: "Never delete production data. Never expose secrets in output.",
    },
  ],
});
```

## Design Principles

1. **Files and CLI over protocols.** No MCP, no custom APIs. If you can't do it with bash, you can't do it.
2. **State in memory, durability on disk.** The turn runner owns `TurnState` in memory and emits events. `SessionManager` writes state and observations to disk on every terminal event, so any process can resume by handing the saved state back to `runner.start`.
3. **Agent-routed state machines over workflow engines.** Long-running state machines describe available business states; a runner agent decides what to do next from prompt, state, and history. Task-level workflows belong inside agent or script states.
4. **Dynamic over static.** Agent states are defined by state machines at runtime, not pre-built classes.
5. **Simple over flexible.** Default pi coding tools. One default memory store. Constraints breed creativity.

## License

Apache-2.0
