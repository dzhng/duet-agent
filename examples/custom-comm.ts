/**
 * Example: Custom communication layer.
 *
 * This demonstrates the key architectural insight — agent logic is completely
 * decoupled from how you talk to the user. You could plug in:
 * - Voice (gpt-realtime as the comm layer, opus as orchestrator)
 * - Video stream (screen capture → text description → orchestrator)
 * - Slack/Discord/Teams
 * - WebSocket for a web UI
 * - Even another AI as the "user"
 */

import { getModel } from "@mariozechner/pi-ai";
import EventEmitter from "eventemitter3";
import {
  Orchestrator,
  type CommLayer,
  type CommMessage,
  type AgentStatus,
  type DuetAgentConfig,
} from "duet-agent";

/**
 * Example: WebSocket-based comm layer.
 * In production this would connect to an actual WebSocket server.
 */
class WebSocketComm implements CommLayer {
  private emitter = new EventEmitter();
  private queue: CommMessage[] = [];
  private waiting: ((msg: CommMessage) => void) | null = null;

  /** Simulate receiving a message from the WebSocket client */
  injectMessage(content: string): void {
    const msg: CommMessage = { kind: "text", content };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(msg);
    } else {
      this.queue.push(msg);
    }
    this.emitter.emit("message", msg);
  }

  async send(message: CommMessage): Promise<void> {
    // In production: ws.send(JSON.stringify(message))
    console.log("[ws:send]", JSON.stringify(message));
  }

  async receive(): Promise<CommMessage> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  onMessage(handler: (message: CommMessage) => void): () => void {
    this.emitter.on("message", handler);
    return () => this.emitter.off("message", handler);
  }

  async sendStatus(status: AgentStatus): Promise<void> {
    // In production: ws.send(JSON.stringify({ type: 'status', ...status }))
    console.log("[ws:status]", JSON.stringify(status));
  }
}

/**
 * Example: Voice comm layer sketch.
 * This shows how you'd wire up gpt-realtime as the user-facing layer
 * while opus handles the actual orchestration.
 */
class VoiceCommSketch implements CommLayer {
  // In production this would use:
  // - gpt-realtime for speech-to-text and text-to-speech
  // - A VAD (voice activity detector) for turn detection
  // - Audio streaming via WebRTC or similar

  private emitter = new EventEmitter();

  async send(message: CommMessage): Promise<void> {
    if (message.kind === "text") {
      // gptRealtime.speak(message.content)
      console.log("[voice:speak]", message.content);
    }
  }

  async receive(): Promise<CommMessage> {
    // gptRealtime.listen() → transcription → CommMessage
    return { kind: "text", content: "(voice transcription would go here)" };
  }

  onMessage(handler: (message: CommMessage) => void): () => void {
    this.emitter.on("message", handler);
    return () => this.emitter.off("message", handler);
  }

  async sendStatus(status: AgentStatus): Promise<void> {
    // Could play a subtle audio cue when thinking, executing, etc.
    console.log("[voice:status]", status.kind);
  }
}

// Demo: using the WebSocket comm
async function main() {
  const comm = new WebSocketComm();

  const config: DuetAgentConfig = {
    orchestratorModel: getModel("anthropic", "claude-opus-4-6"),
    defaultSubAgentModel: getModel("anthropic", "claude-sonnet-4-6"),
    cwd: process.cwd(),
    comm, // ← The only thing that changes
  };

  const orchestrator = new Orchestrator(config);

  // Simulate: user sends goal via WebSocket, then interrupts mid-execution
  setTimeout(() => {
    comm.injectMessage("Actually, also add a /version endpoint");
  }, 5000);

  await orchestrator.run("Create a health check API");
}

main().catch(console.error);
