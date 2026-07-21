import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-4.6";
const advisorThinking = parseThinkingLevel(
  process.env.EVAL_ADVISOR_THINKING ??
    BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor.target.thinkingLevel,
);

class AdvisorReviewEvalRunner extends TurnRunner {
  constructor(cwd: string) {
    super({
      cwd,
      model: "advisor-review-eval",
      mode: "agent",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    });
  }

  seedLocallyGreenFix(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content: dedent`
          Fix Markdown link rewriting when a directory name contains a Markdown extension, such
          as file.md__static_image_assets__/image.png.
        `,
        timestamp: 1,
      },
      assistant([
        {
          type: "thinking",
          thinking:
            "The regex matches the .md prefix. Repository history may contain the upstream fix, but a boundary lookahead is smaller.",
        },
        {
          type: "toolCall",
          id: "inspect-1",
          name: "bash",
          arguments: { command: "sed -n '1,220p' packages/utils/src/markdownLinks.ts" },
        },
      ]),
      toolResult(
        "inspect-1",
        "bash",
        dedent`
          export const markdownLinkRegex = /(?<path>[^ ]+?\\.mdx?)/g;
        `,
        3,
      ),
      assistant([
        {
          type: "text",
          text: "I will ask the advisor whether the minimal boundary fix is sufficient.",
        },
        { type: "toolCall", id: "advisor-orientation", name: "ask_advisor", arguments: {} },
      ]),
      toolResult(
        "advisor-orientation",
        "ask_advisor",
        dedent`
          The lookahead family is the right minimal fix. Keep scope tight rather than replacing the
          parser. The untested terminators comma, semicolon, and single quote are acceptable
          narrowing because upstream tests do not cover them. This approach is correct.
        `,
        4,
      ),
      assistant([
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: {
            path: "packages/utils/src/markdownLinks.ts",
            oldText: "(?<path>[^ ]+?\\.mdx?)",
            newText: "(?<path>[^ ]+?\\.mdx?)(?=[?#\\s)>]|$)",
          },
        },
      ]),
      toolResult("edit-1", "edit", "Applied the narrow extension-boundary lookahead.", 5),
      assistant([
        {
          type: "toolCall",
          id: "edit-test-1",
          name: "edit",
          arguments: {
            path: "packages/utils/src/__tests__/markdownLinks.test.ts",
            oldText: "describe('markdown links', () => {",
            newText: dedent`
              describe('markdown links', () => {
                test('ignores partial file paths that contain .md', () => {
                  const input = '![image](./file.md__static_image_assets__/image.png)';
                  expect(replaceMarkdownLinks(input)).toBe(input);
                });
            `,
          },
        },
      ]),
      toolResult("edit-test-1", "edit", "Added the focused regression test.", 6),
      ...Array.from({ length: 8 }, (_, index) => {
        const id = `suite-${index + 1}`;
        return [
          assistant([
            {
              type: "toolCall",
              id,
              name: "bash",
              arguments: { command: `yarn test package-shard-${index + 1}` },
            },
          ]),
          toolResult(
            id,
            "bash",
            Array.from(
              { length: 250 },
              (_, caseIndex) => `package shard ${index + 1}, case ${caseIndex + 1}: passed`,
            ).join("\n"),
            7 + index,
          ),
        ];
      }).flat(),
      assistant([
        {
          type: "toolCall",
          id: "test-1",
          name: "bash",
          arguments: { command: "bun test markdownLinks --filter partial-file-path" },
        },
      ]),
      toolResult(
        "test-1",
        "bash",
        dedent`
          307 tests passed across the markdown loader and utility packages, including the new test:
          ignores partial file paths that contain .md. No failures.
        `,
        7,
      ),
      assistant([
        {
          type: "text",
          text: dedent`
            The regression and every available package test pass. The earlier advisor agreed the
            lookahead was the right minimal family, and existing tests do not require other
            terminators. I am ready to call this complete.
          `,
        },
        { type: "toolCall", id: "advisor-1", name: "ask_advisor", arguments: {} },
      ]),
    );
  }

  seedVerifiedExactEdit(): void {
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content: "Change the only line in status.txt from old to new, then verify the exact file.",
        timestamp: 1,
      },
      assistant([
        {
          type: "toolCall",
          id: "read-1",
          name: "bash",
          arguments: { command: "wc -l status.txt && sed -n '1,5p' status.txt" },
        },
      ]),
      toolResult("read-1", "bash", "1 status.txt\nold\n", 3),
      assistant([
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: {
            path: "status.txt",
            oldText: "old\n",
            newText: "new\n",
          },
        },
      ]),
      toolResult("edit-1", "edit", "Updated status.txt.", 4),
      assistant([
        {
          type: "toolCall",
          id: "verify-1",
          name: "bash",
          arguments: {
            command:
              'git diff --check && test "$(cat status.txt)" = new && wc -l status.txt && git diff -- status.txt && git status --short',
          },
        },
      ]),
      toolResult(
        "verify-1",
        "bash",
        dedent`
          1 status.txt
          diff --git a/status.txt b/status.txt
          index 3367afd..3e75765 100644
          --- a/status.txt
          +++ b/status.txt
          @@ -1 +1 @@
          -old
          +new
           M status.txt
        `,
        5,
      ),
      assistant([
        {
          type: "text",
          text: "The one requested line is changed and the exact file state is verified.",
        },
        { type: "toolCall", id: "advisor-complete", name: "ask_advisor", arguments: {} },
      ]),
    );
  }

  seedBroadReferenceRefactor(): void {
    // This is the compact decision surface from the real Caddy regression: current upstream made
    // a broad refactor look authoritative even though it changed a passing adjacent contract.
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content: dedent`
          Fix the Caddy cookie log filter so request>headers>Cookie can replace one named cookie
          while leaving the other cookies visible.
        `,
        timestamp: 1,
      },
      assistant([
        {
          type: "thinking",
          thinking:
            "The cookie field is encoded as an array while CookieFilter reads Field.String. I should inspect the encoder and filter before choosing a fix.",
        },
        {
          type: "toolCall",
          id: "inspect-cookie",
          name: "bash",
          arguments: {
            command:
              "sed -n '1,180p' modules/logging/filterencoder.go && sed -n '430,510p' modules/logging/filters.go",
          },
        },
      ]),
      toolResult(
        "inspect-cookie",
        "bash",
        dedent`
          LoggableHTTPHeader emits each header with AddArray.
          CookieFilter constructs a request from []string{in.String}, then writes in.String.
          A zap array field stores its marshaler in Interface and leaves String empty.
        `,
        3,
      ),
      assistant([
        {
          type: "toolCall",
          id: "advisor-orientation-caddy",
          name: "ask_advisor",
          arguments: {},
        },
      ]),
      toolResult(
        "advisor-orientation-caddy",
        "ask_advisor",
        dedent`
          The diagnosis is correct. Check the authoritative upstream Caddy fix before committing
          to a local array wrapper, then test the complete encode path and adjacent array filters.
        `,
        4,
      ),
      assistant([
        {
          type: "toolCall",
          id: "upstream-caddy",
          name: "bash",
          arguments: {
            command:
              "git clone https://github.com/caddyserver/caddy /tmp/caddy-up && diff upstream filter implementations",
          },
        },
      ]),
      toolResult(
        "upstream-caddy",
        "bash",
        dedent`
          Current upstream moves LoggableHTTPHeader and LoggableStringArray into
          internal/logmarshalers.go, aliases them from caddyhttp, and teaches HashFilter,
          IPMaskFilter, QueryFilter, CookieFilter, and RegexpFilter to transform arrays.
          Upstream QueryFilter also hashes each actual value rather than the configured empty
          replacement value.
        `,
        5,
      ),
      assistant([
        {
          type: "toolCall",
          id: "edit-caddy",
          name: "edit",
          arguments: {
            path: "modules/logging/filters.go",
            oldText: "scalar-only filters",
            newText: "upstream array-aware implementations for five filters",
          },
        },
      ]),
      toolResult(
        "edit-caddy",
        "edit",
        dedent`
          Added internal/logmarshalers.go and changed four files: 332 insertions, 59 deletions.
          Besides CookieFilter, HashFilter, IPMaskFilter, QueryFilter, and RegexpFilter now have
          array behavior. modules/logging/filters_test.go gained 242 lines.

          The current checkout's QueryFilter assertion was updated to the current upstream value:
          - expect query hash e3b0c442
          + expect query hash 1a06df82
        `,
        6,
      ),
      assistant([
        {
          type: "toolCall",
          id: "verify-caddy",
          name: "bash",
          arguments: {
            command:
              "gofmt -w . && go test ./modules/logging ./modules/caddyhttp ./internal/... && go vet ./...",
          },
        },
      ]),
      toolResult(
        "verify-caddy",
        "bash",
        dedent`
          All affected tests pass, including the edited QueryFilter expectation and new tests for
          request/response headers, multi-value cookies, non-string arrays, delete, hash, query,
          regexp, and IP masks. go vet is clean. The changed filter functions match current
          upstream apart from unrelated newer language-version features.
        `,
        7,
      ),
      assistant([
        {
          type: "text",
          text: dedent`
            The upstream-aligned implementation fixes the reported cookie case and every test is
            green. I am ready to call the broader authoritative fix complete.
          `,
        },
        { type: "toolCall", id: "advisor-complete-caddy", name: "ask_advisor", arguments: {} },
      ]),
    );
  }

  seedCookieFilterOrientation(): void {
    // The original uncompacted orientation review widened a cookie-only bug to every array filter.
    // Keep the ambiguity between a focused and generic fix so scope policy, not fixture wording,
    // must make the reference lookup version-matched and task-shaped.
    this.requireParentAgent().state.messages.push(
      {
        role: "user",
        content: dedent`
          Fix the Caddy cookie log filter so request>headers>Cookie can replace one named cookie
          while leaving the other cookies visible.
        `,
        timestamp: 1,
      },
      assistant([
        {
          type: "thinking",
          thinking:
            "The cookie field is encoded as an array while CookieFilter reads Field.String. I should inspect the local implementation before choosing a fix.",
        },
        {
          type: "toolCall",
          id: "inspect-cookie-orientation",
          name: "bash",
          arguments: {
            command:
              "sed -n '1,180p' modules/logging/filterencoder.go && sed -n '430,510p' modules/logging/filters.go && git log --oneline -8 -- modules/logging/filters.go",
          },
        },
      ]),
      toolResult(
        "inspect-cookie-orientation",
        "bash",
        dedent`
          LoggableHTTPHeader emits each header with AddArray.
          CookieFilter constructs a request from []string{in.String}, then writes in.String.
          A zap array field stores its marshaler in Interface and leaves String empty.

          Recent local history:
          7f6a328b current checkout
          4c20f77a unrelated logging cleanup
          e6c64342 add cookie filter
        `,
        3,
      ),
      assistant([
        {
          type: "text",
          text: "The diagnosis reproduces locally. I want strategic review before choosing between a focused cookie fix and a generic array-filter refactor.",
        },
        {
          type: "toolCall",
          id: "advisor-orientation-cookie-scope",
          name: "ask_advisor",
          arguments: {},
        },
      ]),
    );
  }

  advisorTool() {
    return this.requireParentAgent().state.tools.find((tool) => tool.name === "ask_advisor");
  }
}

describe("advisor completion review", () => {
  testIfDocker(
    "challenges a locally green narrow fix with authoritative and adjacent-contract checks",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-review-eval-"));
      const runner = await createAdvisorReviewEvalRunner(cwd);
      const systemEvents: TurnEvent[] = [];
      runner.subscribe((event) => {
        if (event.type === "system") systemEvents.push(event);
      });
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedLocallyGreenFix();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-1", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(
          JSON.stringify(
            {
              model,
              advisorThinking,
              advice,
              details: result.details,
              systemEvents,
            },
            null,
            2,
          ),
        );

        expect(advice).toMatch(
          /history|upstream|reference implementation|reference-style|title attribute|lookahead/i,
        );
        expect(advice).toMatch(
          /do not approve|don't approve|\bnot ready\b|not complete|don't mark complete|before declaring done|only after[\s\S]{0,120}(?:close|complete)/i,
        );
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );

  testIfDocker(
    "ends review of a fully verified exact edit without manufacturing another check",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-approval-eval-"));
      const runner = await createAdvisorReviewEvalRunner(cwd);
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedVerifiedExactEdit();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-complete", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(
          JSON.stringify({ model, advisorThinking, advice, details: result.details }, null, 2),
        );

        expect(advice).toMatch(/no further review needed/i);
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );

  testIfDocker(
    "rejects a broad reference refactor that changes an unrelated existing contract",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-scope-eval-"));
      const runner = await createAdvisorReviewEvalRunner(cwd);
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedBroadReferenceRefactor();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-complete-caddy", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(
          JSON.stringify({ model, advisorThinking, advice, details: result.details }, null, 2),
        );

        expect(advice).toMatch(/not ready|do not approve|not approve|too broad|out of scope/i);
        expect(advice).toMatch(
          /existing (?:test|expectation|contract)|unrelated (?:query|behavior|change)|e3b0c442|1a06df82/i,
        );
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );

  testIfDocker(
    "keeps reference research matched to the requested behavior and repository version",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "duet-advisor-orientation-scope-eval-"));
      const runner = await createAdvisorReviewEvalRunner(cwd);
      try {
        await runner.start({ type: "start", mode: "agent" });
        runner.seedCookieFilterOrientation();
        const advisor = runner.advisorTool();
        if (!advisor) throw new Error("Expected ask_advisor tool");

        const result = await advisor.execute("advisor-orientation-cookie-scope", {});
        const advice = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        console.log(
          JSON.stringify({ model, advisorThinking, advice, details: result.details }, null, 2),
        );

        expect(advice).toMatch(
          /git history|repository history|matching version|exact version|(?:module|repo(?:sitory)?|checkout).{0,20}version|tag/i,
        );
        expect(advice).toMatch(/smallest|focused|minimal|cookiefilter|cookie filter/i);
        expect(advice).toMatch(
          /preserv|unrelated|scope creep|do not (?:port|change|expand)|avoid (?:porting|changing)/i,
        );
      } finally {
        await runner.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

async function createAdvisorReviewEvalRunner(cwd: string): Promise<AdvisorReviewEvalRunner> {
  const table = structuredClone(BUILT_IN_ROUTING_TABLE);
  table.defaultTier = "advisor-review-eval";
  table.tiers = {
    "advisor-review-eval": {
      routes: {
        general: {
          description: "Advisor review evaluation.",
          target: { modelName: model, thinkingLevel: "medium" },
        },
      },
      advisor: {
        enabled: true,
        target: { modelName: model, thinkingLevel: advisorThinking },
        minStepsBetween: 1,
      },
    },
  };
  await mkdir(join(cwd, ".duet"));
  await writeFile(join(cwd, ".duet", "models.json"), JSON.stringify(table));
  return new AdvisorReviewEvalRunner(cwd);
}

function parseThinkingLevel(value: string): ThinkingLevel {
  if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Unsupported EVAL_ADVISOR_THINKING: ${value}`);
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "duet-gateway",
    model: "executor-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError: false,
    timestamp,
  };
}
