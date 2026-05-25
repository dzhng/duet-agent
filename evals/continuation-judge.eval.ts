import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judgeContinuesRecentWork } from "./helpers/continuation-judge.js";

/**
 * Judge-the-judge eval for `judgeContinuesRecentWork`.
 *
 * Before `evals/session-compaction-continues-recent-work.eval.ts`
 * uses this judge to grade a real model run, the judge is exercised
 * here against hand-crafted positive and negative replies whose
 * correct verdict is obvious to a human reader. If the judge starts
 * passing the literal cold-greeting reply or failing a clearly
 * substantive continuation, this eval catches it before the live
 * eval false-passes a wire-starvation regression.
 */

const RECENT_WORK = `
The user asked about missing OpenAI "thinking traces" from \`gpt-5.5\`.
Investigation showed \`resolveModelName("gpt-5.5")\` was routing
Duet/OpenAI models through \`vercel-ai-gateway\` with
\`api: "anthropic-messages"\`, which would drop OpenAI reasoning
events. A red eval was added at \`evals/openai-thinking-tracks.eval.ts\`
to reproduce. The fix in \`src/model-resolution/duet-gateway.ts\`
overrides Duet-hosted OpenAI-prefixed models to the OpenAI-compatible
API path while leaving Anthropic models on the Anthropic path. The
recent tool calls were grepping through \`apiProviderRegistry\` and
nearby pi-ai provider wiring to confirm the OpenAI-Responses path
emits reasoning blocks.
`.trim();

// Verbatim reply from the failing session that this judge has to
// reject. If we ever loosen the judge enough to pass this, we have
// regressed.
const COLD_GREETING_REPLY = "I'm here — what would you like to work on next?";

const GENERIC_OFFER_REPLY = `
Happy to keep going! I can help with code, write tests, debug an
issue, or anything else you're working on. Where would you like to
start?
`.trim();

const SUBSTANTIVE_CONTINUATION_REPLY = `
The grep through \`apiProviderRegistry\` in
\`node_modules/@earendil-works/pi-ai\` confirmed that the
\`openai-responses\` API path is the one that surfaces reasoning
deltas, so the override in \`src/model-resolution/duet-gateway.ts\`
should resolve the missing-thinking-traces symptom for \`gpt-5.5\`.
Next step: re-run \`evals/openai-thinking-tracks.eval.ts\` against
the duet-gateway provider and assert \`hasReasoningRequest(payload)\`
is true. Want me to also add a regression in \`test/cli.test.ts\`
pinning the resolved API to \`openai-responses\`?
`.trim();

// A reply that names ONE concrete anchor from the work but otherwise
// punts. Judge should still mark this invalid — naming a file alone
// is not enough; the reply must also propose a step or finding.
const NAME_DROP_ONLY_REPLY = `
We were looking at \`src/model-resolution/duet-gateway.ts\`. What
would you like me to do?
`.trim();

describe("judgeContinuesRecentWork judge-the-judge", () => {
  testIfDocker(
    "rejects the verbatim cold greeting from the failing session",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: COLD_GREETING_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "rejects a generic 'happy to help' offer that lists capabilities",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: GENERIC_OFFER_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "rejects a name-drop with no finding or proposed next step",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: NAME_DROP_ONLY_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "passes a reply that names a concrete anchor and proposes a next step grounded in it",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: SUBSTANTIVE_CONTINUATION_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(true);
    },
    120_000,
  );
});
