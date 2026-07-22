// Slice 00 live probe (specs/connected-providers/slices/00-live-probe.md in duet).
// Verifies which models a ChatGPT plan serves through the codex transport and
// whether a Duet-shaped system prompt passes unaltered. Reads credentials from
// ~/.duet/codex-probe-auth.json (written by the device-code login), refreshing
// and persisting them when expired. Prints a redacted matrix only — never
// token material.
//
//   bun scripts/probe-connected-providers.ts codex [modelId ...]
import { getModel, complete, type Model } from "@earendil-works/pi-ai";
import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_PATH = join(process.env.HOME ?? "", ".duet", "codex-probe-auth.json");
const DEFAULT_IDS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

// Representative Duet-shaped system prompt: multi-section, imperative, with
// tool-use instructions — close enough to detect instruction rewriting or
// rejection. The formal slice-00 pass swaps in the real builder output.
const SYSTEM_PROMPT = [
  "You are Duet, an autonomous coding agent operating inside a user's workspace VM.",
  "Follow the user's instructions exactly. Prefer small, verifiable steps.",
  "When tools are available, call them rather than describing what you would do.",
  "Report outcomes faithfully; if a step fails, say so with the error.",
  "## Response discipline",
  "Answer tersely. This probe expects a single word.",
].join("\n");

const ids = process.argv.slice(3).length > 0 ? process.argv.slice(3) : DEFAULT_IDS;

const stored = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
let credentials = stored.credentials;
let rotated = "not-refreshed";
if (credentials.expires < Date.now() + 60_000) {
  const before = credentials.refresh;
  credentials = await refreshOpenAICodexToken(credentials);
  rotated = credentials.refresh === before ? "refresh-token-stable" : "refresh-token-ROTATED";
  writeFileSync(
    AUTH_PATH,
    JSON.stringify({ ...stored, credentials, savedAt: Date.now() }, null, 2),
  );
}
console.log(`auth: expires=${new Date(credentials.expires).toISOString()} rotation=${rotated}`);

const donor = getModel("openai-codex", "gpt-5.5");
if (!donor) throw new Error("pi-ai no longer ships openai-codex:gpt-5.5 (synthesis donor)");

for (const id of ids) {
  const model = { ...donor, id, name: id } as Model<typeof donor.api>;
  const startedAt = Date.now();
  try {
    const message = await complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      },
      { apiKey: credentials.access },
    );
    const text = message.content
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("")
      .trim();
    console.log(
      `${id}: SERVED in ${Date.now() - startedAt}ms stop=${message.stopReason} ` +
        `tokens=${JSON.stringify(message.usage ?? {})} text=${JSON.stringify(text.slice(0, 60))}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`${id}: REFUSED ${JSON.stringify(detail.slice(0, 300))}`);
  }
}
