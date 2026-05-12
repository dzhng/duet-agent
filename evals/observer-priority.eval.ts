import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import type { ObservationPriority } from "../src/types/memory.js";
import { createMemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { createAssistantMessage } from "../test/helpers/messages.js";

// Verify the live observer naturally classifies content into the intended
// priority buckets without per-scenario instruction overrides.
//
// Classification contract:
//   🔴 High    — durable user-identity facts, explicit preferences,
//                unresolved critical decisions/blockers
//   🟡 Medium  — routine work executed this session: tool results, code
//                structure, hypotheses, normal task requests being performed
//   🟢 Low     — tentative, speculative, uncertain observations and
//                incidental details whose future value is unclear
//   ✅         — concrete completion (rolls up to "high" via inferPriority)

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

interface Scenario {
  name: string;
  expected: ObservationPriority;
  messages: AgentMessage[];
}

function user(text: string, offsetMs = 0): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now() + offsetMs,
  };
}

function assistant(text: string, offsetMs = 0): AgentMessage {
  return createAssistantMessage({ text, timestamp: Date.now() + offsetMs });
}

const scenarios: Scenario[] = [
  {
    name: "high: user identity assertion",
    expected: "high",
    messages: [
      user("Quick context: I work at Acme Corp as a backend engineer on the payments team."),
      assistant("Got it, thanks for the context."),
    ],
  },
  {
    name: "high: explicit user preference",
    expected: "high",
    messages: [
      user("Going forward I prefer terse answers without any preamble or sign-off."),
      assistant("Understood."),
    ],
  },
  {
    name: "high: concrete completion",
    expected: "high",
    messages: [
      user("Add a null check at auth.ts:45."),
      assistant("Added the null check at auth.ts:45 and the test suite passes."),
      user("Great, that's done."),
    ],
  },
  {
    name: "medium: agent reasoning / hypothesis from tool output",
    expected: "medium",
    messages: [
      user("Why might that endpoint be slow?"),
      assistant(
        "I read handler.ts and saw a synchronous for-loop over awaited fetch() calls on lines 40-58. Sequential network IO would explain elevated latency under load. I have not profiled, but this is the most likely cause based on the code.",
      ),
    ],
  },
  {
    name: "low: explicit speculation, no measurement",
    expected: "low",
    messages: [
      user("hmm idk, maybe it's the cache? not sure"),
      assistant(
        "I haven't measured anything. It might be the cache, the DB connection pool, or the network — it's too early to tell without instrumentation.",
      ),
      user("ok lets not dig in yet"),
    ],
  },
  {
    name: "low: tentative incidental detail",
    expected: "low",
    messages: [
      user("Casually browsing the repo, nothing specific. Anything stand out?"),
      assistant(
        "I noticed src/util/legacy.ts in the tree. It might be unused, but it could also be dynamically imported via require() — I haven't grepped for usages. Just a tentative impression worth flagging in case cleanup matters later.",
      ),
      user("interesting, no rush though"),
    ],
  },
];

describe("observer priority inference", () => {
  for (const scenario of scenarios) {
    testIfDocker(
      scenario.name,
      async () => {
        const fixture = await createMemoryFixture();
        try {
          await updateObservationalMemory({
            db: fixture.db,
            memory: fixture.cache,
            sessionId: "session_eval",
            effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
            actorModel: memoryModel,
            messages: scenario.messages,
          });

          const snapshot = await fixture.snapshot("session_eval");
          const observation = snapshot.observations.at(0);
          console.log(
            `\n[${scenario.name}] expected=${scenario.expected} got=${observation?.priority ?? "<no observation>"}\n--- content ---\n${observation?.content ?? "(empty)"}\n---`,
          );

          expect(observation).toBeDefined();
          expect(observation!.priority).toBe(scenario.expected);
        } finally {
          await fixture.dispose();
        }
      },
      45_000,
    );
  }
});
