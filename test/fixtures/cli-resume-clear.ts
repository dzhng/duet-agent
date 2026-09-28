import { mock } from "bun:test";
import type { RunTuiInput } from "../../src/tui/app.js";

// The terminal is the boundary: real CLI/session setup runs between simulated
// clear and exit actions without rendering or touching the host desktop.
const observed: unknown[] = [];
mock.module("../../src/tui/app.js", () => ({
  runTui: async (input: RunTuiInput) => {
    await input.session.start();
    observed.push({
      displayModel: input.modelName,
      model: input.session.getState()?.options?.model,
      memoryModel: input.session.getState()?.options?.memoryModel,
      routing: input.session.routeStatus(),
    });
    if (observed.length === 1) input.onClearRequest?.();
    if (observed.length === 2 && process.env.DUET_TEST_CLEAR_RESUME_OTHER === "1")
      input.onResumeRequest?.("other");
    return undefined;
  },
}));
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
const { runRunCommand } = await import("../../src/cli/run.js");
await runRunCommand(
  [
    "--resume",
    "saved",
    "--incognito",
    "--no-auto-upgrade",
    "--workdir",
    process.argv[2]!,
    ...process.argv.slice(3),
  ],
  { name: "@duetso/agent", version: "0.3.28" },
);
process.stdout.write(JSON.stringify(observed));
process.exit(0);
