# duet-agent

An opinionated, full-stack agent harness. Native memories. Native sandboxes. Native interrupts. Multi-agent by default.

**No MCP. Everything is files and CLI.**

## Why another agent framework?

Existing agent harnesses treat tools, memories, and sandboxes as pluggable modules. This makes them flexible but fundamentally disconnected — memory is an afterthought, sandboxes are optional, and interrupts are hacked in.

duet-agent takes the opposite approach: **memories, sandboxes, and interrupts are woven into the core architecture.** An agent without memory is stateless. An agent without a sandbox can't act. An agent that can't be interrupted can't collaborate.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Communication Layer                    │
│           (stdio / voice / video / websocket)            │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                      Orchestrator                        │
│  • Takes user goal                                       │
│  • Breaks into tasks                                     │
│  • Dynamically defines sub-agents                        │
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
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Memory   │  │ Sandbox  │  │Interrupts│  │Guardrails│ │
│  │(observed)│  │ (bash)   │  │(user+env)│  │(optional)│ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Key Differentiators

### Native Memory

Memory is first-class, but the harness itself has **zero persistence logic**. The default `MemoryStore` is in-memory and emits events for every raw-message, observation, and buffer update. Persistence is intentionally built outside the harness: subscribe to memory events and write them wherever you want, or hydrate a store with initial state before passing it to the orchestrator.

The memory model follows observational memory: raw messages accumulate, an observer compresses them into text observations, and a reflector condenses observations when they grow too large. Observations are scoped as `session` or `resource`; both can be persisted by external modules.

### Native Sandboxes

Every action goes through bash. No MCP, no custom protocols — just `exec("command")`, `readFile`, `writeFile`. The sandbox interface is simple enough to swap between local execution, Docker, Firecracker, or cloud sandboxes without changing agent code.

### Native Interrupts

Both users AND the environment can interrupt agents. A log file watcher, a webhook, a test failure, or a user typing a message — anything can push an interrupt onto the bus. Interrupts have priority levels: **pause** (halt immediately), **queue** (process after current turn), or **info** (non-blocking awareness).

### Multi-Agent by Default

The orchestrator doesn't execute tasks — it defines sub-agents dynamically and manages a session state machine. Sub-agents are not pre-built classes. The orchestrator creates them on-the-fly with custom roles, instructions, model selection, tool permissions, and memory access.

### Decoupled Communication

Agent logic is completely separated from how you talk to the user. Swap the comm layer for voice (gpt-realtime), video stream analysis, Slack, WebSocket, or anything else. The orchestrator doesn't know or care.

### Optional Guardrails

Pattern-based (fast, regex) and semantic (LLM-evaluated) guardrails compose into a firewall. Every bash command and file write can be checked before execution.

## Install

```bash
npm install duet-agent
```

## Development

This repo uses Bun for package management and Docker for functional tests.

```bash
bun install
bun run setup  # install/start Docker on macOS or Linux if needed
bun run test   # runs the test suite inside Docker
```

Raw `bun test` skips Docker-only functional tests so they do not create files on the host machine.

## Quick Start

### CLI

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-...

# Run
npx duet-agent "build a REST API with Express"

# With options
npx duet-agent -m claude-opus-4-6 --sub-model claude-sonnet-4-6 "refactor the auth module"
```

### Programmatic

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { Orchestrator, LocalSandbox, StdioComm } from "duet-agent";

const orchestrator = new Orchestrator({
  orchestratorModel: getModel("anthropic", "claude-opus-4-6"),
  defaultSubAgentModel: getModel("anthropic", "claude-sonnet-4-6"),
  sandbox: new LocalSandbox(process.cwd()),
  comm: new StdioComm(),
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

Observational memory is enabled by default with conservative long-context thresholds:

- Raw messages are observed around `30_000` tokens.
- Observation logs are reflected around `40_000` tokens.
- Raw-tail retention uses `bufferActivation` to keep recent unobserved messages after observation activation.
- Observation context is injected as reminder messages; replacing raw context with observations/reflections is the compaction path.

## Custom Communication Layer

The comm layer is an interface. Implement it to plug in any I/O surface:

```typescript
import type { CommLayer, CommMessage, AgentStatus } from "duet-agent";

class SlackComm implements CommLayer {
  async send(message: CommMessage) {
    /* post to Slack */
  }
  async receive() {
    /* wait for Slack message */
  }
  onMessage(handler) {
    /* subscribe to Slack events */
  }
  async sendStatus(status: AgentStatus) {
    /* update Slack presence */
  }
}
```

This enables architectures like:

- **Voice agent**: gpt-realtime as comm layer → Opus as orchestrator → OSS models as sub-agents
- **Screen agent**: video stream → vision model transcription → orchestrator
- **Team agent**: Slack channel as comm layer → orchestrator manages work

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
3. **Dynamic over static.** Sub-agents are defined at runtime by the orchestrator, not pre-built classes.
4. **Decoupled over integrated.** Agent logic doesn't know how it talks to users. Swap the comm layer freely.
5. **Simple over flexible.** One sandbox primitive (bash). One default memory store. One interrupt bus. Constraints breed creativity.

## License

Apache-2.0
