# duet-agent

An opinionated, full-stack agent harness. Native memories. Native interrupts. Multi-agent by default.

**No MCP. Everything is files and CLI.**

## Why another agent framework?

Existing agent harnesses treat tools and memories as pluggable modules. This makes them flexible but fundamentally disconnected — memory is an afterthought.

duet-agent takes the opposite approach: **memory is woven into the core architecture.** An agent without memory is stateless. Interrupts are handled by the underlying pi agent runtime, so the harness does not need its own interrupt bus.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Orchestrator                        │
│  • Takes prompt + options                               │
│  • Breaks into tasks                                     │
│  • Dynamically defines sub-agents                        │
│  • Chooses agent / state_machine / auto mode             │
│  • Manages session state machine                         │
│  • Evaluates results                                     │
└────┬───────────┬───────────┬───────────┬────────────────┘
     │           │           │           │
┌────▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐
│Sub-Agent│ │Sub-Agent│ │Sub-Agent│ │Sub-Agent│  ← dynamically defined
│(coder)  │ │(research)│ │(review) │ │(sysadm) │
└────┬────┘ └───┬────┘ └───┬────┘ └───┬────┘
     │          │          │          │
┌────▼──────────▼──────────▼──────────▼───────────────────┐
│                    Shared Infrastructure                  │
│        Memory (observed) │ Pi │ Guardrails                │
│        pi coding tools run in the configured cwd          │
└─────────────────────────────────────────────────────────┘
```

## Key Differentiators

### Native Memory

Memory is first-class, but the harness itself has **zero persistence logic**. The default `MemoryStore` is in-memory and emits events for raw-message and observation changes. Persistence is intentionally built outside the harness: subscribe to memory events and write them wherever you want, or pass saved state back to `Orchestrator.run()`.

The memory model follows observational memory: raw messages accumulate, an observer compresses them into text observations, and a reflector condenses observations when they grow too large. Observations are scoped as `session` or `resource`; both can be persisted by external modules.

### Pi Coding Tools

Sub-agents use the default tools from `@mariozechner/pi-coding-agent`: read, bash, edit, and write. The harness supplies a working directory and filters the allowed tool names; it does not wrap those tools in a second sandbox abstraction.

### Native Interrupts

Interrupt behavior comes from the underlying pi agent runtime. A user can send a message while a pi session is running, and the runtime can handle it as an interruption or as a follow-up. duet-agent does not add a second interrupt bus on top.

### Multi-Agent by Default

The orchestrator doesn't execute tasks — it defines sub-agents dynamically and manages a session state machine. Sub-agents are not pre-built classes. The orchestrator creates them on-the-fly with custom roles, instructions, model selection, tool permissions, and memory access.

### Three Execution Modes

The orchestrator has three top-level modes:

- `agent`: handle the prompt as a normal agent run. This is for one-off tasks, coding requests, reviews, research, and anything that can complete in the current session.
- `state_machine`: route the prompt into an agent-routed state machine. This is for long-running business processes with durable state, waits, and terminal business outcomes.
- `auto`: let the orchestrator classify the prompt and choose either `agent` or `state_machine`.

The current code is still scaffolding, but this is the intended boundary: normal agent mode handles immediate work, while state-machine mode handles business processes that may pause, resume, wait on external systems, or start in the middle based on the user's prompt.

### Agent-Routed State Machines

duet-agent is exploring long-running agent-routed state machines for business processes like outbound sales, conference outreach, and development loops. The design goal is **not** to become a workflow engine like Temporal, Airflow, or GitHub Actions.

Instead, state machines are agent-routed. A state-machine definition describes the available business states: agent states, shell-script states, wait states, and terminal states. A state-machine runner agent sees the original prompt, current state, state history, and available state definitions, then decides what should happen next.

The state machine is higher level than task execution. It tracks one current business state at a time. If a state needs fan-out, parallelism, or a task-level workflow, that belongs inside an agent or script state. The agent can execute a complex workflow internally; the state machine only records the business transition before and after that state.

This keeps state machines flexible enough to start in the middle. For example, a user can say: "prospect person X, I've already sent email, just wait for response." The same outreach state machine can skip research and email sending, then choose the wait-for-response state because the runner agent understands the existing context.

External integrations stay simple: anything with an API or CLI is a script state or polling wait. Email, GitHub, Calendly, CRM systems, and webhooks do not need first-class engine concepts. If the state machine can tolerate a few minutes of polling delay, a bash script is enough.

What this is not:

- Not a deterministic DAG scheduler.
- Not a low-level durable execution runtime.
- Not a workflow service with queues, workers, locks, and retries as the main abstraction.
- Not a replacement for infrastructure workflow engines when exact-once execution or strict SLAs matter.

The harness should provide enough structure for an agent to make good process decisions, while leaving hard operational guarantees to external systems.

### Optional Guardrails

Pattern-based (fast, regex) and semantic (LLM-evaluated) guardrails compose into a firewall. Every bash command and file write can be checked before execution.

## Install

```bash
npm install duet-agent
```

## Development

This repo uses Bun for package management, Husky for pre-commit checks, and Docker for functional tests.

```bash
bun install
bun run setup  # install/start Docker on macOS or Linux if needed
bun run check-types
bun run lint
bun run eval   # runs live evals in evals/*.eval.ts
bun run test   # runs the test suite inside Docker
```

Raw `bun test` skips Docker-only functional tests so they do not create files on the host machine.

The pre-commit hook runs `format`, `check-types`, and `lint`.

## Quick Start

### CLI

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-...

# Run
npx duet-agent "build a REST API with Express"

# With options
npx duet-agent -m anthropic:claude-opus-4-6 --sub-model anthropic:claude-sonnet-4-6 "refactor the auth module"

# Through Vercel AI Gateway
export AI_GATEWAY_API_KEY=...
npx duet-agent -m vercel-ai-gateway:anthropic/claude-opus-4.6 "review this repo"
```

### Programmatic

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { Orchestrator } from "duet-agent";

const orchestrator = new Orchestrator({
  orchestratorModel: getModel("anthropic", "claude-opus-4-6"),
  defaultSubAgentModel: getModel("anthropic", "claude-sonnet-4-6"),
  cwd: process.cwd(),
  mode: "auto",
  maxConcurrency: 3,
});

const state = await orchestrator.run("Build a todo app with React and TypeScript");
```

## Memory And Persistence

duet-agent owns a concrete event-emitting `MemoryStore` internally. It is the runtime state container, not a database adapter.

```typescript
import type { MemoryPersistenceModule } from "duet-agent";

const persistence: MemoryPersistenceModule = {
  async load(store) {
    // Hydrate the internal runtime store before the first run.
  },
  subscribe(store) {
    return store.on((event) => {
      // Persist externally: append to a log, write JSON, sync to Postgres, etc.
      console.log(event.type, event);
    });
  },
};
```

Persistence modules hydrate the internal store before a run and subscribe to events for future writes. The harness should not know whether state came from a file, database, cache, or test fixture.

You can also resume directly from saved state:

```typescript
const state = await orchestrator.run("Continue the previous goal", {
  runState: savedRunState,
  memory: savedMemorySnapshot,
  resume: "auto",
});
```

Resume continues the orchestration run state, not an in-flight model/tool call. Any `in_progress` todo is retried from `pending`.

Observational memory is enabled by default with conservative long-context thresholds:

- Raw messages are observed around `30_000` tokens.
- Observation logs are reflected around `40_000` tokens.
- Raw-tail retention uses `bufferActivation` to keep recent unobserved messages after observation activation.
- Observation context is injected as reminder messages; replacing raw context with observations/reflections is the compaction path.

## Skills

Skills are loaded from `<cwd>/.agents/skills` and `~/.agents/skills` by default, using `@mariozechner/pi-coding-agent`'s skill loader. `getSkills()` returns the discovered skills, including YAML frontmatter descriptions such as block scalars.

## Guardrails

The harness installs its default safety checks internally. Add extra guardrail config objects when a deployment needs stricter local policy.

```typescript
const orchestrator = new Orchestrator({
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
2. **Runtime state over persistence.** The harness owns in-memory state and emits events. Persistence lives in external modules or initial-state hydration.
3. **Agent-routed state machines over workflow engines.** Long-running state machines describe available business states; a runner agent decides what to do next from prompt, state, and history. Task-level workflows belong inside agent or script states.
4. **Dynamic over static.** Sub-agents are defined at runtime by the orchestrator, not pre-built classes.
5. **Simple over flexible.** Default pi coding tools. One default memory store. Constraints breed creativity.

## License

Apache-2.0
