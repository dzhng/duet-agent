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
│  │(semantic) │  │ (bash)   │  │(user+env)│  │(optional)│ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Key Differentiators

### Native Memory

Memories are first-class citizens, not a bolted-on RAG pipeline. Every agent can read and write memories. Memories have semantic embeddings, importance scores, scoping (session vs persistent), and automatic consolidation. The orchestrator uses memories from past sessions to inform planning.

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
import {
  Orchestrator,
  FileMemoryStore,
  LocalSandbox,
  StdioComm,
  PatternGuardrail,
} from "duet-agent";

const orchestrator = new Orchestrator({
  orchestratorModel: getModel("anthropic", "claude-opus-4-6"),
  defaultSubAgentModel: getModel("anthropic", "claude-sonnet-4-6"),
  memory: new FileMemoryStore("./.duet-agent/memory"),
  sandbox: new LocalSandbox(process.cwd()),
  comm: new StdioComm(),
  guardrails: [new PatternGuardrail()],
  maxConcurrency: 3,
});

const state = await orchestrator.run("Build a todo app with React and TypeScript");
```

## Custom Communication Layer

The comm layer is an interface. Implement it to plug in any I/O surface:

```typescript
import type { CommLayer, CommMessage, AgentStatus } from "duet-agent";

class SlackComm implements CommLayer {
  async send(message: CommMessage) { /* post to Slack */ }
  async receive() { /* wait for Slack message */ }
  onMessage(handler) { /* subscribe to Slack events */ }
  async sendStatus(status: AgentStatus) { /* update Slack presence */ }
}
```

This enables architectures like:

- **Voice agent**: gpt-realtime as comm layer → Opus as orchestrator → OSS models as sub-agents
- **Screen agent**: video stream → vision model transcription → orchestrator
- **Team agent**: Slack channel as comm layer → orchestrator manages work

## Guardrails

```typescript
import { PatternGuardrail, SemanticGuardrail, createFirewall } from "duet-agent";

// Fast: regex pattern matching
const patterns = new PatternGuardrail();

// Smart: LLM-evaluated safety
const semantic = new SemanticGuardrail(
  getModel("anthropic", "claude-haiku-4-5"),
  "Never delete production data. Never expose secrets in output."
);

// Compose into a firewall
const firewall = createFirewall([patterns, semantic]);
```

## Design Principles

1. **Files and CLI over protocols.** No MCP, no custom APIs. If you can't do it with bash, you can't do it.
2. **Native over modular.** Memory, sandboxes, and interrupts are part of every agent turn, not optional plugins.
3. **Dynamic over static.** Sub-agents are defined at runtime by the orchestrator, not pre-built classes.
4. **Decoupled over integrated.** Agent logic doesn't know how it talks to users. Swap the comm layer freely.
5. **Simple over flexible.** One sandbox primitive (bash). One memory store. One interrupt bus. Constraints breed creativity.

## License

Apache-2.0