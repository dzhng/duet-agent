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

// Verify the observer treats tool-call and tool-result blocks as background
// context, and applies the ground-truth rule: tool exchanges that only
// restate re-runnable facts (file contents, listings, grep output) should
// NOT produce an observation — `hasMemory=false`. Exchanges that produce
// durable signal (decisions, completions, blockers) should produce an
// observation at the appropriate priority, without transcribing raw tool
// arguments or raw tool output.

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

interface Scenario {
  name: string;
  /**
   * Expected observation priority, or `"none"` when the exchange should
   * produce no observation at all (the observer should return
   * `hasMemory=false` because the content is re-discoverable ground
   * truth).
   */
  expected: ObservationPriority | "none";
  messages: AgentMessage[];
  /** Substrings that should appear in the observation (specific facts the agent acted on). */
  expectedSubstrings?: string[];
  /** Substrings that should NOT appear in the observation (raw tool I/O bleed-through). */
  forbiddenSubstrings?: string[];
}

function user(text: string, offsetMs = 0): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now() + offsetMs,
  };
}

function assistantWithToolCall(input: {
  text?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  offsetMs?: number;
}): AgentMessage {
  return createAssistantMessage({
    text: input.text,
    extraContent: [
      {
        type: "toolCall",
        id: input.toolCallId,
        name: input.toolName,
        arguments: input.args,
      },
    ],
    timestamp: Date.now() + (input.offsetMs ?? 0),
  });
}

function toolResult(input: {
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
  offsetMs?: number;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: [{ type: "text", text: input.text }],
    isError: input.isError ?? false,
    timestamp: Date.now() + (input.offsetMs ?? 0),
  };
}

// A realistically large file listing — the kind of payload that, if
// transcribed verbatim, would dominate the observation.
const LARGE_DIRECTORY_LISTING = Array.from(
  { length: 80 },
  (_, i) => `src/module${i.toString().padStart(2, "0")}.ts`,
).join("\n");

// A realistically large grep output — wide enough that the observer must
// summarize rather than copy.
const LARGE_GREP_OUTPUT = Array.from(
  { length: 40 },
  (_, i) =>
    `src/handlers/route${i}.ts:42:  if (request.headers["x-api-key"] !== process.env.API_KEY)`,
).join("\n");

const scenarios: Scenario[] = [
  {
    // Pure file inspection with no decision, no novel discovery, no
    // blocker. The agent can re-read src/auth.ts next turn for the same
    // information, so the observer should record nothing.
    name: "no observation when the agent only restates re-readable code",
    expected: "none",
    messages: [
      user(
        "Just for context, can you read src/auth.ts and tell me how the login handler is shaped?",
      ),
      assistantWithToolCall({
        text: "Let me read the auth file.",
        toolCallId: "call_read_auth",
        toolName: "read_file",
        args: { path: "src/auth.ts", offset: 40, limit: 20 },
        offsetMs: 1,
      }),
      toolResult({
        toolCallId: "call_read_auth",
        toolName: "read_file",
        offsetMs: 2,
        text: [
          "  40| export async function login(req: Request, res: Response) {",
          "  41|   const { email, password } = req.body;",
          "  42|   if (!email || !password) {",
          '  43|     return res.status(400).json({ error: "missing credentials" });',
          "  44|   }",
          "  45|   const user = await db.users.findByEmail(email);",
          '  46|   if (!user) return res.status(401).json({ error: "invalid" });',
          "  47|   const ok = await bcrypt.compare(password, user.passwordHash);",
          '  48|   if (!ok) return res.status(401).json({ error: "invalid" });',
          "  49|   const token = signJwt({ userId: user.id });",
          "  50|   return res.json({ token });",
          "  51| }",
        ].join("\n"),
      }),
      createAssistantMessage({
        text: "The login handler at src/auth.ts:40-51 reads `email` and `password` from the request body, returns 400 if either is missing, looks up the user by email, returns 401 if the user is missing or the password fails bcrypt.compare, and otherwise signs a JWT with `user.id` and returns it.",
        timestamp: Date.now() + 3,
      }),
    ],
  },
  {
    // Same rule as above: a directory listing is trivially re-runnable.
    // The agent extracted no decision, hypothesis, or blocker — just
    // described what's already on disk. No observation should be recorded.
    name: "no observation when the agent only restates a directory listing",
    expected: "none",
    messages: [
      user("How is the src tree organized?"),
      assistantWithToolCall({
        toolCallId: "call_ls_src",
        toolName: "bash",
        args: { command: "ls src/" },
        offsetMs: 1,
      }),
      toolResult({
        toolCallId: "call_ls_src",
        toolName: "bash",
        offsetMs: 2,
        text: LARGE_DIRECTORY_LISTING,
      }),
      createAssistantMessage({
        text: "The src tree contains 80 module files named module00.ts through module79.ts. The naming is flat and numeric — there's no subdirectory structure under src/.",
        timestamp: Date.now() + 3,
      }),
    ],
  },
  {
    // Grep ground truth is re-runnable, but here the user and agent agree
    // on a refactor approach. The decision ("consolidate into shared
    // middleware") is durable — the grep output that prompted it is not.
    name: "captures a refactor decision reached after a wide grep",
    expected: "medium",
    messages: [
      user("Where do we check the API key header? I want to consolidate it."),
      assistantWithToolCall({
        toolCallId: "call_grep_api_key",
        toolName: "grep",
        args: { pattern: "x-api-key", path: "src/handlers" },
        offsetMs: 1,
      }),
      toolResult({
        toolCallId: "call_grep_api_key",
        toolName: "grep",
        offsetMs: 2,
        text: LARGE_GREP_OUTPUT,
      }),
      createAssistantMessage({
        text: "Every request handler under src/handlers/ has its own `x-api-key` header check at line 42. We should move this into a shared `requireApiKey` middleware in `src/middleware/auth.ts` and remove the per-route checks.",
        timestamp: Date.now() + 3,
      }),
      user(
        "Yes, let's do that — extract a `requireApiKey` middleware and have every handler in src/handlers/ use it.",
      ),
    ],
    // The durable signal is the agreed plan: extract a middleware named
    // `requireApiKey`, applied across `src/handlers/`. The raw match
    // count and route filenames are re-discoverable and should not
    // dominate the observation.
    expectedSubstrings: ["requireApiKey", "middleware"],
    forbiddenSubstrings: ["route15.ts:42", "route25.ts:42", "route37.ts:42"],
  },
  {
    name: "treats a state-changing tool result as a concrete completion",
    expected: "high",
    messages: [
      user("Add a null check at src/auth.ts:46 before the bcrypt compare."),
      assistantWithToolCall({
        text: "Editing src/auth.ts.",
        toolCallId: "call_edit_auth",
        toolName: "edit_file",
        args: {
          path: "src/auth.ts",
          oldString:
            "  const user = await db.users.findByEmail(email);\n  // BUG: no null check before password compare\n  const ok = await bcrypt.compare(password, user.passwordHash);",
          newString:
            '  const user = await db.users.findByEmail(email);\n  if (!user) return res.status(401).json({ error: "invalid" });\n  const ok = await bcrypt.compare(password, user.passwordHash);',
        },
        offsetMs: 1,
      }),
      toolResult({
        toolCallId: "call_edit_auth",
        toolName: "edit_file",
        offsetMs: 2,
        text: "Applied 1 replacement in src/auth.ts.",
      }),
      assistantWithToolCall({
        text: "Running the auth tests.",
        toolCallId: "call_run_tests",
        toolName: "bash",
        args: { command: "bun test test/auth.test.ts" },
        offsetMs: 3,
      }),
      toolResult({
        toolCallId: "call_run_tests",
        toolName: "bash",
        offsetMs: 4,
        text: "test/auth.test.ts:\n(pass) login rejects unknown email\n(pass) login rejects bad password\n(pass) login issues a token on success\n\n3 pass\n0 fail\nRan 3 tests across 1 file.",
      }),
      createAssistantMessage({
        text: "Added the null check at src/auth.ts:46. All 3 auth tests pass.",
        timestamp: Date.now() + 5,
      }),
    ],
    expectedSubstrings: ["auth.ts", "null check"],
  },
  {
    name: "surfaces a tool error as the observation focus",
    expected: "medium",
    messages: [
      user("Run the build."),
      assistantWithToolCall({
        toolCallId: "call_build",
        toolName: "bash",
        args: { command: "bun run build" },
        offsetMs: 1,
      }),
      toolResult({
        toolCallId: "call_build",
        toolName: "bash",
        isError: true,
        offsetMs: 2,
        text: "src/payments/charge.ts(127,12): error TS2532: Object is possibly 'undefined'.\nsrc/payments/charge.ts(143,5): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\nerror: \"tsc\" exited with code 2",
      }),
      createAssistantMessage({
        text: "Build failed with 2 TypeScript errors in src/payments/charge.ts at lines 127 and 143 — both around possibly-undefined values. Want me to fix them?",
        timestamp: Date.now() + 3,
      }),
    ],
    expectedSubstrings: ["src/payments/charge.ts", "127", "143"],
  },
];

describe("observer treats tool calls as context", () => {
  for (const scenario of scenarios) {
    testIfDocker(
      scenario.name,
      async () => {
        const fixture = await createMemoryFixture();
        try {
          await updateObservationalMemory({
            session: fixture.session,
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

          if (scenario.expected === "none") {
            // The ground-truth rule: re-runnable tool exchanges with no
            // decision attached must not produce a stored observation.
            expect(snapshot.observations).toHaveLength(0);
            return;
          }

          expect(observation).toBeDefined();
          expect(observation!.priority).toBe(scenario.expected);

          for (const needle of scenario.expectedSubstrings ?? []) {
            expect(observation!.content).toContain(needle);
          }
          for (const forbidden of scenario.forbiddenSubstrings ?? []) {
            expect(observation!.content).not.toContain(forbidden);
          }
        } finally {
          await fixture.dispose();
        }
      },
      60_000,
    );
  }
});
