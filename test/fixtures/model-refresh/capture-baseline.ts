import { pinnedDefaultModel, pinnedMemoryModel } from "../../../src/model-resolution/catalog.js";
import { modelRefreshCompletion } from "../../helpers/model-refresh-upstream.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Session } from "../../../src/session/session.js";
import { resolveCliModel, resolveModelName } from "../../../src/model-resolution/resolver.js";
process.env.DUET_API_KEY = "qualification-controlled";
const requests: unknown[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = (await request.json()) as { model: string };
    requests.push({ url: new URL(request.url).pathname, payload });
    return modelRefreshCompletion(payload.model);
  },
});
process.env.DUET_GATEWAY_BASE_URL = server.url.toString();
const receipts = [];
const inputs = process.argv.slice(2);
for (const input of inputs.length ? inputs : ["opus", "sol", "terra", "luna"]) {
  const selection = resolveCliModel(
    input === "provider-duet" ? pinnedDefaultModel("duet-gateway") : input,
    new Set(),
  );
  const sessionPath = `/tmp/home/sessions/${input}`;
  await mkdir(sessionPath, { recursive: true });
  const session = new Session(
    {
      model: selection.modelName,
      ...(input === "provider-duet" ? { memoryModel: pinnedMemoryModel("duet-gateway") } : {}),
      mode: "agent",
      cwd: "/tmp/home",
      memoryDbPath: false,
      skillDiscovery: { includeDefaults: false },
    },
    { id: input, sessionPath },
  );
  await session.start();
  await session.prompt({ message: "Return qualification done." });
  const terminal = await session.waitForTerminal();
  await session.dispose();
  if (terminal.type !== "complete") throw new Error(JSON.stringify(terminal));
  const envelope = JSON.parse(await readFile(`${sessionPath}/state.json`, "utf8"));
  receipts.push({ input, selection, dispatch: resolveModelName(selection.modelName).id, envelope });
}
await writeFile(
  `/out/${inputs.includes("provider-duet") ? "provider" : inputs.includes("grok") ? "other-families" : "standalone"}-baseline.json`,
  JSON.stringify(
    {
      commit: "6cb40aa5062f24aa2bde1971f9ea521440996175",
      command: "bun test/fixtures/model-refresh/capture-baseline.ts",
      receipts,
      requests,
    },
    null,
    2,
  ) + "\n",
);

server.stop(true);
