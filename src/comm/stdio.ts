import { createInterface } from "node:readline";
import { EventEmitter } from "eventemitter3";
import type { AgentStatus, CommLayer, CommMessage } from "../core/types.js";

/**
 * Terminal-based communication layer. The simplest possible comm adapter.
 *
 * Input: stdin (user types messages)
 * Output: stdout (agent prints responses)
 */
export class StdioComm implements CommLayer {
  private emitter = new EventEmitter();
  private messageQueue: CommMessage[] = [];
  private rl;
  private waiting: ((msg: CommMessage) => void) | null = null;

  constructor() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      const msg: CommMessage = { kind: "text", content: line };
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(msg);
      } else {
        this.messageQueue.push(msg);
      }
      this.emitter.emit("message", msg);
    });
  }

  async send(message: CommMessage): Promise<void> {
    switch (message.kind) {
      case "text":
        console.log(message.content);
        break;
      case "error":
        console.error(`Error: ${message.message}`);
        break;
      case "file":
        console.log(`[File: ${message.path} (${message.mimeType})]`);
        break;
      case "structured":
        console.log(JSON.stringify(message.data, null, 2));
        break;
    }
  }

  async receive(): Promise<CommMessage> {
    const queued = this.messageQueue.shift();
    if (queued) return queued;

    return new Promise<CommMessage>((resolve) => {
      this.waiting = resolve;
    });
  }

  onMessage(handler: (message: CommMessage) => void): () => void {
    this.emitter.on("message", handler);
    return () => this.emitter.off("message", handler);
  }

  async sendStatus(status: AgentStatus): Promise<void> {
    switch (status.kind) {
      case "thinking":
        process.stderr.write(`⠿ ${status.description ?? "Thinking..."}\n`);
        break;
      case "executing":
        process.stderr.write(`▶ ${status.description ?? "Executing..."}\n`);
        break;
      case "waiting":
        process.stderr.write(`⏳ ${status.reason}\n`);
        break;
      case "idle":
        break;
    }
  }

  destroy(): void {
    this.rl.close();
  }
}
