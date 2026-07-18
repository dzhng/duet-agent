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
import { startTurn } from "../test/helpers/turn-runner-protocol.js";

const KIMI_ID = "moonshotai/kimi-k3";
const SOL_ID = "openai/gpt-5.6-sol";
const LUNA_ID = "openai/gpt-5.6-luna";
const FABLE_ID = "anthropic/claude-fable-5";
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
    "routes visual work to Kimi and the later backend implementation to Sol",
    async () => {
      // Deliberately ignore EVAL_MODEL: this promotion case must exercise --model frontier
      // semantics through the real built-in table, real Luna classifier, and production cadence.
      const cwd = await mkdtemp(join(tmpdir(), "duet-model-routing-mixed-task-"));
      await seedTask(cwd);

      const runner = new TurnRunner({
        model: "frontier",
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
            1. Read index.html in its own tool call.
            2. Read styles.css in its own tool call.
            3. Edit index.html in its own tool call: add a hero__content wrapper around the copy
               and add a hero__cta link labeled "Start free".
            4. Edit styles.css in its own tool call: make .hero a polished two-column grid, style
               the CTA and panel, and add an @media responsive single-column layout.
            5. Run "bun frontend-check.ts" in its own tool call. Do not start backend work unless it
               prints frontend-ok.

            BACKEND PHASE — non-visual TypeScript implementation:
            6. Read the rate-limiter.ts skeleton in its own tool call.
            7. Edit rate-limiter.ts in its own tool call. Implement a per-key fixed-window
               RateLimiter(limit, windowMs, now = Date.now) with consume(key), reset(key), and
               RateLimitDecision. Validate positive integer limit and positive windowMs.
            8. Create rate-limiter.test.ts in its own tool call with Bun tests for independent keys,
               exhausted limits, retryAfterMs, window rollover, reset, and invalid configuration.
            9. Run "bun test ./rate-limiter.test.ts" in its own tool call.
            10. Read rate-limiter.test.ts again in its own tool call and identify one missing exact
                boundary assertion.
            11. Edit rate-limiter.test.ts in its own tool call to add that boundary assertion.
            12. Run "bun test ./rate-limiter.test.ts" again in its own tool call. Stop only after
                the final test run passes, then summarize both completed phases.
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
        expect(backendCalls.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(5);
        expect(visualCalls.some((call) => call.model === KIMI_ID)).toBe(true);
        expect(backendCalls.some((call) => call.model === SOL_ID)).toBe(true);
        // The promotion contract: phases START in order, the cadence switch
        // lands kimi→sol around the transition, and sol does real backend
        // work after it. Deliberately NOT asserted: phase-END ordering by
        // max index. Two correct behaviors break it — cadence lag (the model
        // may begin backend steps up to a window before the check fires) and
        // final verification (re-running the frontend check while wrapping
        // up). Both were observed in live acceptance runs; pinning them
        // would test incidental sequence, not routing behavior.
        const isMutating = (call: RoutedToolCall) => call.tool !== "read";
        const visualWork = visualCalls.filter(isMutating);
        const backendWork = backendCalls.filter(isMutating);
        expect(visualWork.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(1);
        expect(backendWork.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(1);
        expect(visualWork[0]!.index).toBeLessThan(backendWork[0]!.index);
        expect(visualWork.some((call) => call.model === KIMI_ID)).toBe(true);
        const kimiToSol = switches.find(
          (event) => event.fromModel === "kimi-k3" && event.toModel === "gpt-5.6-sol",
        );
        expect(kimiToSol, JSON.stringify(switches, null, 2)).toBeDefined();
        const solBackendWork = backendWork.filter((call) => call.model === SOL_ID);
        expect(solBackendWork.length, JSON.stringify(calls, null, 2)).toBeGreaterThanOrEqual(1);

        const cadenceSwitches = switches.filter((event) => event.trigger === "cadence");
        expect(cadenceSwitches.length, JSON.stringify(switches, null, 2)).toBeGreaterThanOrEqual(1);
        expect(switches.length).toBeLessThanOrEqual(MAX_SWITCHES);
        const kimiSwitchIndex = switches.findIndex((event) => event.toModel === "kimi-k3");
        const solSwitchIndex = switches.findIndex(
          (event, index) => index > kimiSwitchIndex && event.toModel === "gpt-5.6-sol",
        );
        expect(kimiSwitchIndex, JSON.stringify(switches, null, 2)).toBeGreaterThanOrEqual(0);
        expect(solSwitchIndex, JSON.stringify(switches, null, 2)).toBeGreaterThan(kimiSwitchIndex);
        for (const switched of switches) {
          expect(["kimi-k3", "gpt-5.6-sol"]).toContain(switched.toModel);
          expect(switched.thinkingLevel).toBe("high");
        }

        const parentModels = new Set(calls.map((call) => call.model));
        expect(parentModels.has(LUNA_ID)).toBe(false);
        expect(parentModels.has(FABLE_ID)).toBe(false);
        expect(calls.some((call) => call.tool === "ask_advisor")).toBe(false);
        expect([...parentModels].every((model) => model === KIMI_ID || model === SOL_ID)).toBe(
          true,
        );

        const kimiUsage = usageByModel.find((entry) => entry.model === KIMI_ID);
        const solUsage = usageByModel.find((entry) => entry.model === SOL_ID);
        expect(kimiUsage?.usage.totalTokens ?? 0).toBeGreaterThan(0);
        expect(solUsage?.usage.totalTokens ?? 0).toBeGreaterThan(0);
        // Luna may contribute as the observational-memory actor. Classifier calls are deliberately
        // outside the parent transcript and do not currently enter the runner's usage aggregate.
        expect(
          usageByModel.every((entry) => [KIMI_ID, SOL_ID, LUNA_ID].includes(entry.model)),
        ).toBe(true);
        expect(terminal.turnUsage).toBeDefined();
        expect(usageByModel.reduce((total, entry) => total + entry.usage.totalTokens, 0)).toBe(
          terminal.turnUsage!.totalTokens,
        );
        expect(
          usageByModel.reduce((total, entry) => total + entry.usage.cost.total, 0),
        ).toBeCloseTo(terminal.turnUsage!.cost.total, 9);
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
    },
    700_000,
  );
});
