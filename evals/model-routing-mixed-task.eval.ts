import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect } from "bun:test";
import dedent from "dedent";
import type {
  ModelUsageEntry,
  TurnEvent,
  TurnRouterSwitchEvent,
  TurnUsageEvent,
} from "../src/types/protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { bestOfAttempts } from "../test/helpers/best-of.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { exportRoutingTable } from "../src/model-routing/loader.js";
import { classifierPath } from "../src/model-routing/classifier.js";
import { resolveMeteredModelName } from "../src/model-resolution/resolver.js";

const tier = process.env.EVAL_TIER ?? "frontier";
const targets = {
  frontier: {
    visual: "opus",
    visualId: "anthropic/claude-opus-5.5",
    implement: "sol",
    implementId: "openai/gpt-6.1-sol",
  },
  balanced: {
    visual: "sonnet",
    visualId: "anthropic/claude-sonnet-5.5",
    implement: "sol",
    implementId: "openai/gpt-6.1-sol",
  },
};
if (!(tier in targets)) throw new Error(`Unknown EVAL_TIER: ${tier}`);
const target = targets[tier as keyof typeof targets];
const VISUAL_ID = target.visualId;
const IMPLEMENT_ID = target.implementId;
const FABLE_ID = "anthropic/claude-fable-5.1";
const MAX_SWITCHES = 4;

interface RoutedToolCall {
  index: number;
  model: string;
  tool: string;
  input: string;
  phase: "visual" | "backend" | "other";
}

function toolPhase(input: string): RoutedToolCall["phase"] {
  if (/index\.html|styles\.css|frontend-check/i.test(input)) return "visual";
  if (/rate-limiter/i.test(input)) return "backend";
  return "other";
}

function routedToolCalls(messages: readonly AgentMessage[]): RoutedToolCall[] {
  const calls: RoutedToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const input = JSON.stringify(block.arguments ?? {});
      calls.push({
        index: calls.length,
        model: message.model,
        tool: block.name,
        input,
        phase: toolPhase(input),
      });
    }
  }
  return calls;
}

function compactUsage(
  entries: readonly ModelUsageEntry[],
): Record<string, { tokens: number; cost: number }> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.model,
      {
        tokens: entry.usage.totalTokens,
        cost: Number(entry.usage.cost.total.toFixed(6)),
      },
    ]),
  );
}

function compactAssistantTurns(messages: readonly AgentMessage[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      model: message.model,
      stopReason: message.stopReason,
      text: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      tools: message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({ name: block.name, arguments: block.arguments })),
    }));
}

async function seedTask(cwd: string): Promise<void> {
  await Promise.all([
    writeFile(
      join(cwd, "index.html"),
      dedent`
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link rel="stylesheet" href="styles.css" />
            <title>Orbit</title>
          </head>
          <body>
            <main class="hero">
              <div>
                <p class="eyebrow">Release intelligence</p>
                <h1>Ship with a clearer view.</h1>
                <p>Orbit turns noisy delivery signals into one calm release picture.</p>
              </div>
              <aside class="hero__panel">Deployment confidence: 94%</aside>
            </main>
          </body>
        </html>
      `,
    ),
    writeFile(
      join(cwd, "styles.css"),
      dedent`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: system-ui, sans-serif; background: #07111f; color: #f8fafc; }
        .hero { min-height: 100vh; padding: 4rem; }
        .hero__panel { padding: 2rem; background: #12233d; border-radius: 1rem; }
      `,
    ),
    writeFile(
      join(cwd, "frontend-check.ts"),
      dedent`
        const html = await Bun.file("index.html").text();
        const css = await Bun.file("styles.css").text();
        if (!html.includes('class="hero__content"')) throw new Error("missing hero content wrapper");
        if (!html.includes('class="hero__cta"')) throw new Error("missing hero CTA");
        if (!css.includes("grid-template-columns")) throw new Error("hero is not a grid");
        if (!css.includes("@media")) throw new Error("missing responsive layout");
        console.log("frontend-ok");
      `,
    ),
    writeFile(
      join(cwd, "rate-limiter.ts"),
      dedent`
        export interface RateLimitDecision {
          allowed: boolean;
          remaining: number;
          retryAfterMs: number;
        }

        export class RateLimiter {
          // TODO: implement a per-key fixed-window limiter with an injected clock.
        }
      `,
    ),
  ]);
}

describe("mixed-task model routing promotion", () => {
  testIfDocker(
    `routes ${tier} visual work to ${target.visual} and later implementation to ${target.implement}`,
    async () => {
      // Live executors occasionally under-run the eight-step script (observed:
      // ending the turn after the frontend phase) — executor variance, not
      // routing behavior.
      await bestOfAttempts(2, runMixedTaskScenario);
    },
    1_500_000,
  );

  async function runMixedTaskScenario(): Promise<void> {
    // Deliberately ignore EVAL_MODEL: this promotion case exercises the selected tier
    // semantics through the real built-in table, configured classifier, and production cadence.
    const cwd = await mkdtemp(join(tmpdir(), "duet-model-routing-mixed-task-"));
    await seedTask(cwd);
    const { table } = await exportRoutingTable({ cwd, force: false });
    const classifierModelId =
      classifierPath(table.classifier.target) === "evaluation"
        ? table.classifier.target.modelName
        : resolveMeteredModelName(table.classifier.target.modelName).id;

    const runner = new TurnRunner({
      model: tier,
      mode: "agent",
      cwd,
      memoryDbPath: false,
      systemPromptFiles: [],
      skillDiscovery: { includeDefaults: false },
      systemInstructions: dedent`
          This is a live model-routing acceptance task. Work autonomously until every requested
          file change and verification is complete. Do not call ask_advisor, recall_memory, or
          todo_write. Do not ask questions. Follow the two phases in the user's exact order.

          Make exactly ONE filesystem or bash tool call per assistant message, then wait for its
          result before making the next call. Never batch or parallelize tool calls. Briefly name
          the action and phase before each call so the router can observe the real work transition.
          Do not skip a requested read, edit, or verification even if the current files look close.
        `,
    });
    const events: TurnEvent[] = [];
    const usageSnapshots: TurnUsageEvent[] = [];
    runner.subscribe((event) => {
      events.push(event);
      if (event.type === "usage") usageSnapshots.push(event);
    });

    try {
      const { turn } = await startTurn(runner, {
        mode: "agent",
        prompt: dedent`
            Complete this single coding task in two strictly ordered phases. Finish and verify the
            FRONTEND PHASE before beginning the BACKEND PHASE.

            FRONTEND PHASE — visual implementation:
            1. Run "sed -n '1,220p' index.html styles.css" in its own tool call so both visual
               files are inspected together.
            2. Edit index.html in its own tool call: add a hero__content wrapper around the copy
               and add a hero__cta link labeled "Start free".
            3. Edit styles.css in its own tool call: make .hero a polished two-column grid, style
               the CTA and panel, and add an @media responsive single-column layout.
            4. Run "bun frontend-check.ts" in its own tool call. Do not start backend work unless it
               prints frontend-ok.

            BACKEND PHASE — non-visual TypeScript implementation:
            5. Read the rate-limiter.ts skeleton in its own tool call. This is deliberately the
               fifth call: the production cadence must classify this backend boundary before the
               implementation call that follows.
            6. Edit rate-limiter.ts in its own tool call. Implement a per-key fixed-window
               RateLimiter(limit, windowMs, now = Date.now) with consume(key), reset(key), and
               RateLimitDecision. Validate positive integer limit and positive windowMs.
            7. Create rate-limiter.test.ts in its own tool call with Bun tests for independent keys,
               exhausted limits, retryAfterMs, window rollover, reset, and invalid configuration.
            8. Run "bun test ./rate-limiter.test.ts" in its own tool call. Stop only after it passes,
               then summarize both completed phases.
          `,
      });
      const terminal = await turn;
      const switches = events.filter(
        (event): event is TurnRouterSwitchEvent => event.type === "router_switch",
      );
      const calls = routedToolCalls(terminal.state.agent.messages);
      const visualCalls = calls.filter((call) => call.phase === "visual");
      const backendCalls = calls.filter((call) => call.phase === "backend");
      const usageByModel = terminal.usageByModel ?? [];
      const assistantTurns = compactAssistantTurns(terminal.state.agent.messages);

      console.log(
        "MIXED_TASK_PROMOTION_EVIDENCE",
        JSON.stringify(
          {
            switches: switches.map(({ trigger, route, fromModel, toModel, thinkingLevel }) => ({
              trigger,
              route,
              fromModel,
              toModel,
              thinkingLevel,
            })),
            routedTools: calls.map(({ index, model, tool, phase }) => ({
              index,
              model,
              tool,
              phase,
            })),
            assistantTurnCount: assistantTurns.length,
            usageByModel: compactUsage(usageByModel),
            usageSnapshots: usageSnapshots.length,
            turnCost: terminal.turnUsage?.cost.total,
            turnTokens: terminal.turnUsage?.totalTokens,
            terminal: terminal.type,
          },
          null,
          2,
        ),
      );

      expect(terminal.type).toBe("complete");
      expect(terminal.type === "complete" ? terminal.status : undefined).toBe("completed");
      expect(visualCalls.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(3);
      expect(visualCalls.some((call) => call.model === VISUAL_ID)).toBe(true);
      expect(backendCalls.some((call) => call.model === IMPLEMENT_ID)).toBe(true);
      // The promotion contract: phases START in order, the cadence switch
      // lands around the transition, and the implementation model does real backend
      // work after it. Deliberately NOT asserted: phase-END ordering by
      // max index. Two correct behaviors break it — cadence lag (the model
      // may begin backend steps up to a window before the check fires) and
      // final verification (re-running the frontend check while wrapping
      // up). Both were observed in live acceptance runs; pinning them
      // would test incidental sequence, not routing behavior.
      const isMutation = (call: RoutedToolCall) => call.tool === "edit" || call.tool === "write";
      const visualWork = visualCalls.filter(isMutation);
      const backendWork = backendCalls.filter(isMutation);
      expect(visualWork.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(1);
      expect(backendWork.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(1);
      expect(visualWork[0]!.index).toBeLessThan(backendWork[0]!.index);
      expect(visualWork.some((call) => call.model === VISUAL_ID)).toBe(true);
      const phaseSwitch = switches.find(
        (event) => event.fromModel === target.visual && event.toModel === target.implement,
      );
      expect(phaseSwitch, JSON.stringify(switches, null, 2)).toBeDefined();
      const implementationWork = backendWork.filter((call) => call.model === IMPLEMENT_ID);
      expect(
        implementationWork.length,
        JSON.stringify({ calls, assistantTurns }, null, 2),
      ).toBeGreaterThanOrEqual(1);
      expect(backendWork[0]?.model, JSON.stringify({ calls, assistantTurns }, null, 2)).toBe(
        IMPLEMENT_ID,
      );
      expect(visualWork.some((call) => call.model === IMPLEMENT_ID)).toBe(false);

      // Advisor lifecycle checkpoints are steered in as system-reminder user
      // messages; the one real user message is the prompt itself.
      const userMessages = terminal.state.agent.messages.filter(
        (message) =>
          message.role === "user" && !JSON.stringify(message.content).includes("<system-reminder>"),
      );
      expect(userMessages).toHaveLength(1);

      const cadenceSwitches = switches.filter((event) => event.trigger === "cadence");
      expect(cadenceSwitches.length, JSON.stringify(switches, null, 2)).toBeGreaterThanOrEqual(1);
      expect(switches.length).toBeLessThanOrEqual(MAX_SWITCHES);
      const visualSwitchIndex = switches.findIndex((event) => event.toModel === target.visual);
      const implementSwitchIndex = switches.findIndex(
        (event, index) => index > visualSwitchIndex && event.toModel === target.implement,
      );
      expect(visualSwitchIndex, JSON.stringify(switches, null, 2)).toBeGreaterThanOrEqual(0);
      expect(implementSwitchIndex, JSON.stringify(switches, null, 2)).toBeGreaterThan(
        visualSwitchIndex,
      );
      for (const switched of switches) {
        expect([target.visual, target.implement]).toContain(switched.toModel);
        expect(switched.thinkingLevel).toBe("medium");
      }

      const parentModels = new Set(calls.map((call) => call.model));
      expect(parentModels.has(classifierModelId)).toBe(false);
      expect(parentModels.has(FABLE_ID)).toBe(false);
      expect(calls.some((call) => call.tool === "ask_advisor")).toBe(false);
      expect(
        [...parentModels].every((model) => model === VISUAL_ID || model === IMPLEMENT_ID),
      ).toBe(true);

      const visualUsage = usageByModel.find((entry) => entry.model === VISUAL_ID);
      const implementationUsage = usageByModel.find((entry) => entry.model === IMPLEMENT_ID);
      const classifierUsage = usageByModel.find((entry) => entry.model === classifierModelId);
      expect(visualUsage?.usage.totalTokens ?? 0).toBeGreaterThan(0);
      expect(implementationUsage?.usage.totalTokens ?? 0).toBeGreaterThan(0);
      // Memory is disabled and the classifier never executes parent work in this scenario,
      // so this row can only come from the real route classifier.
      expect(classifierUsage?.usage.totalTokens ?? 0).toBeGreaterThan(0);
      expect(
        usageByModel.every((entry) =>
          [VISUAL_ID, IMPLEMENT_ID, classifierModelId].includes(entry.model),
        ),
      ).toBe(true);
      expect(terminal.turnUsage).toBeDefined();
      expect(usageByModel.reduce((total, entry) => total + entry.usage.totalTokens, 0)).toBe(
        terminal.turnUsage!.totalTokens,
      );
      expect(usageByModel.reduce((total, entry) => total + entry.usage.cost.total, 0)).toBeCloseTo(
        terminal.turnUsage!.cost.total,
        9,
      );
      expect(usageSnapshots.at(-1)?.usageByModel).toEqual(usageByModel);

      const html = await readFile(join(cwd, "index.html"), "utf8");
      const css = await readFile(join(cwd, "styles.css"), "utf8");
      expect(html).toContain('class="hero__content"');
      expect(html).toContain('class="hero__cta"');
      expect(css).toContain("grid-template-columns");
      expect(css).toContain("@media");
      const verification = Bun.spawn(["bun", "test", "./rate-limiter.test.ts"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await verification.exited).toBe(0);
    } finally {
      await runner.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
