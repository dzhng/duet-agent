import { deriveTelemetry } from "./src/telemetry.js";
import { runDuetTurn, spawnLocalDuetRpc } from "./src/duet-client.js";

const args = process.argv.slice(2);
if (args[0] !== "rollout" || args[1] !== "local") {
  throw new Error('Usage: bun benchmarks/swebench/cli.ts rollout local --prompt "What is 2+2?"');
}

const promptIndex = args.indexOf("--prompt");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
if (!prompt) throw new Error("rollout local requires --prompt");

const transport = spawnLocalDuetRpc([
  "--incognito",
  "--model",
  "economy",
  "--no-system-prompt-files",
]);
const outcome = await runDuetTurn(
  transport,
  { limits: { costUsd: 1, wallClockMs: 120_000 } },
  prompt,
);
const transcriptTail = outcome.events
  .filter((event) => event.type === "step" && event.step.type === "text")
  .slice(-3)
  .map((event) => (event.type === "step" && event.step.type === "text" ? event.step.text : ""));

console.log(
  JSON.stringify(
    { terminal: outcome.terminal, transcriptTail, telemetry: deriveTelemetry(outcome.events) },
    null,
    2,
  ),
);
