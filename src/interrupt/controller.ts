import { nanoid } from "nanoid";
import { EventEmitter } from "eventemitter3";
import type { Interrupt, InterruptBus } from "../core/types.js";

/**
 * The interrupt controller is the nervous system of the agent harness.
 *
 * Three priority levels:
 * - "pause"  — immediately halt the current agent turn (user interrupt, guardrail block)
 * - "queue"  — process after current turn completes (environment update, log change)
 * - "info"   — non-blocking, just for awareness (status updates)
 *
 * Both users AND the environment can interrupt. A log file watcher, a webhook,
 * a test failure — anything can push an interrupt onto the bus.
 */
export class InterruptController implements InterruptBus {
  private emitter = new EventEmitter();
  private queue: Interrupt[] = [];
  private paused = false;

  emit(partial: Omit<Interrupt, "id" | "timestamp">): void {
    const interrupt: Interrupt = {
      id: nanoid(8),
      timestamp: Date.now(),
      ...partial,
    };

    if (interrupt.priority === "pause") {
      this.paused = true;
    }

    if (interrupt.priority === "queue") {
      this.queue.push(interrupt);
    }

    this.emitter.emit("interrupt", interrupt);
  }

  on(handler: (interrupt: Interrupt) => void): () => void {
    this.emitter.on("interrupt", handler);
    return () => this.emitter.off("interrupt", handler);
  }

  waitFor(predicate: (interrupt: Interrupt) => boolean, timeoutMs = 60_000): Promise<Interrupt> {
    return new Promise<Interrupt>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Interrupt wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (interrupt: Interrupt) => {
        if (predicate(interrupt)) {
          cleanup();
          resolve(interrupt);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off("interrupt", handler);
      };

      this.emitter.on("interrupt", handler);
    });
  }

  drain(): Interrupt[] {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }

  /** Check if a pause interrupt has been received. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Resume after a pause interrupt has been handled. */
  resume(): void {
    this.paused = false;
  }
}
