/**
 * End-to-end headless verification for the CLI image-paste pipeline.
 *
 * Exercises the same code path `inputField.onPaste` runs inside the TUI:
 *   raw bytes -> sniffImageMimeType -> persistPastedImage -> TurnPromptImage
 * Then builds a TurnPromptCommand with images and confirms the test
 * turn-runner harness forwards them as a multimodal AgentMessage to the agent.
 *
 * Run with: bun scripts/verify-paste.ts [optional/path/to/image.png]
 */

import { readFileSync } from "node:fs";

import {
  loadImageFromPath,
  persistPastedImage,
  sniffImageMimeType,
} from "../src/tui/paste.js";
import { createTurnRunner, startTurn } from "../test/helpers/turn-runner-protocol.js";

const argPath = process.argv[2];

async function main(): Promise<void> {
  console.log("[1/4] sniff supported MIME from raw bytes");
  const headers = {
    "image/png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/jpeg": Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
    "image/gif": Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    "image/webp": Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]),
  };
  for (const [expected, header] of Object.entries(headers)) {
    const got = sniffImageMimeType(header);
    if (got !== expected) {
      throw new Error(`sniff failed for ${expected}: got ${String(got)}`);
    }
    console.log(`  ok ${expected}`);
  }

  console.log("\n[2/4] persistPastedImage round-trip on a synthetic PNG");
  const sessionId = `verify-${Date.now()}`;
  const synthetic = new Uint8Array(256);
  synthetic.set(headers["image/png"], 0);
  for (let i = 8; i < synthetic.length; i++) synthetic[i] = i & 0xff;
  const pending = await persistPastedImage({
    sessionId,
    id: 1,
    bytes: synthetic,
    mimeType: "image/png",
  });
  console.log(`  cached at ${pending.path}`);
  console.log(`  label    ${pending.label}`);
  console.log(`  base64   ${pending.attachment.data.slice(0, 32)}\u2026 (${pending.attachment.data.length} chars)`);
  const onDisk = readFileSync(pending.path);
  if (!onDisk.equals(Buffer.from(synthetic))) {
    throw new Error("disk bytes do not match input");
  }
  if (Buffer.from(pending.attachment.data, "base64").compare(Buffer.from(synthetic)) !== 0) {
    throw new Error("base64 round-trip failed");
  }
  console.log("  ok bytes match on disk and after base64 decode");

  console.log("\n[3/4] real-image path: loadImageFromPath");
  if (argPath) {
    const realPending = await loadImageFromPath({
      cwd: process.cwd(),
      rawPath: argPath,
      id: 2,
    });
    console.log(`  loaded   ${realPending.path}`);
    console.log(`  mime     ${realPending.attachment.mimeType}`);
    console.log(`  bytes    ${Buffer.from(realPending.attachment.data, "base64").length}`);
    console.log("  ok loaded and validated real image");
  } else {
    console.log("  (skipped \u2014 no path argument; pass an image path to exercise this)");
  }

  console.log("\n[4/4] TurnPromptCommand carries images into the agent worker");
  const { runner } = createTurnRunner();
  const { turn } = await startTurn(runner, {
    mode: "agent",
    prompt: "Please describe the attached image.",
  });
  await turn;
  // The default test harness ignores images on the start prompt, so drive a
  // second prompt that explicitly attaches one and inspect what landed.
  await runner.turn({
    type: "prompt",
    message: "And one more with an attachment.",
    behavior: "follow_up",
    images: [pending.attachment],
  });

  // Find the worker invocation that received images.
  const worker = runner.workerInputs.find((w) => w.images && w.images.length > 0);
  if (!worker) throw new Error("no worker input received images");
  const img = worker.images?.[0];
  if (!img || img.type !== "image" || img.mimeType !== "image/png") {
    throw new Error("worker image content has unexpected shape");
  }
  if (Buffer.from(img.data, "base64").compare(Buffer.from(synthetic)) !== 0) {
    throw new Error("worker received different bytes than we attached");
  }
  console.log("  ok worker received ImageContent with matching bytes");
  console.log(`     prompt text: ${JSON.stringify(worker.prompt)}`);
  console.log(`     images:      ${worker.images?.length} attached`);

  console.log("\nAll headless verifications passed.");
}

main().catch((error) => {
  console.error("\nFAIL:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
