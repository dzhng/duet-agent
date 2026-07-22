import { describe, expect } from "bun:test";
import { complete, type Context } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveModelName } from "../src/model-resolution/resolver.js";
import { resolveProviderApiKey } from "../src/model-resolution/duet-gateway.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { capturedWirePayload } from "./helpers/capture-wire-payload.js";
import { judgeContinuesRecentWork } from "./helpers/continuation-judge.js";

/**
 * Live-model red/green TDD eval for the `session_VO5yjfS1vV6_`
 * wire-starvation bug.
 *
 * Replays the saved session through the production memory + wire-shaping
 * path to get the EXACT system prompt + AgentMessage[] the runner would
 * have dispatched on the next turn, fires `complete()` against a real
 * model, and grades the reply with `judgeContinuesRecentWork`.
 *
 * EXPECTED state today: RED. The wire payload carries no real user
 * messages and no in-session transcript, so the model produces a cold
 * "I'm here — what would you like to work on next?"-shaped reply that
 * the judge rejects.
 *
 * When the wire-shaping bug is fixed (e.g. the eviction horizon stops
 * dropping the only fresh user steer, or reflection is forced before
 * eviction so the local pack carries the lost turns), the dispatched
 * payload will once again carry the recent transcript and the same
 * model run should produce a substantive continuation that flips the
 * judge to valid=true — closing the loop without changing this eval.
 *
 * Run via the docker eval harness so the path matches `bun run eval`:
 *
 *   docker run --rm -v "$PWD:/src:ro" -w /work -e HOME=/tmp/home \
 *     -e DUET_TEST_IN_DOCKER=1 \
 *     -e DUET_API_KEY="$DUET_API_KEY" \
 *     oven/bun:1.3.11 sh -lc 'cp -R /src/. /work && \
 *     bun install --frozen-lockfile >/dev/null 2>&1 && \
 *     bun test ./evals/session-compaction-continues-recent-work.eval.ts'
 */

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "session_VO5yjfS1vV6_");
const SESSION_ID = "session_VO5yjfS1vV6_";

// Description of the work that was in flight at the moment the
// session lost its footing. Sourced from the user-visible turn just
// before the cold-greeting reply. Kept verbatim so the judge can
// match concrete anchors (`apiProviderRegistry`,
// `src/model-resolution/duet-gateway.ts`,
// `evals/openai-thinking-traces.eval.ts`) regardless of which way
// the model phrases its continuation.
const RECENT_WORK = dedent`
  The user asked about missing OpenAI "thinking traces" from
  \`sol\`. Investigation showed \`resolveModelName("sol")\`
  was routing Duet/OpenAI models through \`vercel-ai-gateway\` with
  \`api: "anthropic-messages"\`, which would drop OpenAI reasoning
  events. A red eval was added at
  \`evals/openai-thinking-traces.eval.ts\` to reproduce. The fix in
  \`src/model-resolution/duet-gateway.ts\` overrides Duet-hosted
  OpenAI-prefixed models to the OpenAI-compatible API path while
  leaving Anthropic models on the Anthropic path. The most recent
  tool calls were grepping through \`apiProviderRegistry\` and the
  pi-ai \`openai-responses\` provider to confirm where reasoning
  blocks surface.
`;

const EVAL_MODEL = process.env.EVAL_MODEL ?? "sonnet-4.6";

describe("session_VO5yjfS1vV6_ wire-starvation continuation", () => {
  testIfDocker(
    "the next turn produces a substantive continuation of the in-flight work",
    async () => {
      // The system-prompt snapshot is committed alongside state.json
      // and memory-dump.json so the eval reproduces what the original
      // session actually saw on the wire, not whatever
      // `createSystemPromptWithAppendedLayers` would render against
      // the CURRENT AGENTS.md + installed skills. AGENTS.md drifts
      // and skill discovery is environment-sensitive (docker /work
      // vs host cwd produced ~10KB vs ~21KB at capture time), so a
      // live rebuild would silently change what the model sees.
      const [stateJson, dumpJson, systemPromptSnapshot] = await Promise.all([
        readFile(join(FIXTURE_DIR, "state.json"), "utf8"),
        readFile(join(FIXTURE_DIR, "memory-dump.json"), "utf8"),
        readFile(join(FIXTURE_DIR, "system-prompt.txt"), "utf8"),
      ]);

      const { payload, dispose } = await capturedWirePayload({
        turnState: JSON.parse(stateJson),
        memoryDump: JSON.parse(dumpJson),
        sessionId: SESSION_ID,
        systemPromptOverride: systemPromptSnapshot,
      });

      try {
        const model = resolveModelName(EVAL_MODEL);
        const context: Context = {
          systemPrompt: payload.systemPrompt,
          messages: convertToLlm(payload.dispatched),
        };
        // pi-ai's built-in env-key map does not know the project-local
        // `duet-gateway` provider, so a bare `complete()` would resolve
        // an empty apiKey. Pass it explicitly via the project shim.
        const apiKey = resolveProviderApiKey(model.provider);
        const response = await complete(model, context, apiKey ? { apiKey } : undefined);
        const replyText = response.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();

        expect(replyText.length, "model produced no text reply").toBeGreaterThan(0);

        const verdict = await judgeContinuesRecentWork({
          reply: replyText,
          recentWork: RECENT_WORK,
        });

        // The diagnostic shape this eval is locking in: today the
        // dispatched payload carries no real user transcript, so
        // the judge sees a cold greeting and returns valid=false.
        // A fix that restores transcript on the wire flips this to
        // valid=true and the eval goes green.
        expect(
          verdict.valid,
          dedent`
          Judge reason: ${verdict.reason}

          Reply was:
          ${replyText}

          Wire shape:
            retainedMessageCount=${payload.retainedMessageCount}
            dispatched.length=${payload.dispatched.length}
            dispatchedHasRealUser=${payload.dispatchedHasRealUser}
        `,
        ).toBe(true);
      } finally {
        await dispose();
      }
    },
    180_000,
  );
});
