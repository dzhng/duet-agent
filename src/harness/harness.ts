import type { DuetAgentConfig } from "../types/config.js";
import type {
  HarnessAnswerCommand,
  HarnessCommand,
  HarnessEvent,
  HarnessInterruptCommand,
  HarnessPromptCommand,
  HarnessStartCommand,
  HarnessTerminalTurnEvent,
} from "../types/protocol.js";

export type HarnessEventHandler = (event: HarnessEvent) => void;

/**
 * Protocol-facing harness scaffold.
 *
 * This class owns the command/event shape but does not implement agent or
 * state-machine execution yet. Tests can use it as the stable API boundary while
 * the runtime behavior is filled in behind the typed handlers.
 */
export class Harness {
  private readonly eventHandlers = new Set<HarnessEventHandler>();

  constructor(readonly config: DuetAgentConfig) {}

  subscribe(handler: HarnessEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Start one harness turn from a protocol command.
   *
   * The eventual implementation should emit during-turn events through
   * `emit(...)` and resolve with the terminal event that ends the turn.
   */
  async turn(command: HarnessCommand): Promise<HarnessTerminalTurnEvent> {
    switch (command.type) {
      case "start":
        return this.start(command);
      case "prompt":
        return this.prompt(command);
      case "answer":
        return this.answer(command);
      case "interrupt":
        return this.interrupt(command);
    }
  }

  protected emit(event: HarnessEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  protected async start(_command: HarnessStartCommand): Promise<HarnessTerminalTurnEvent> {
    throw new Error("Harness.start is not implemented yet");
  }

  protected async prompt(_command: HarnessPromptCommand): Promise<HarnessTerminalTurnEvent> {
    throw new Error("Harness.prompt is not implemented yet");
  }

  protected async answer(_command: HarnessAnswerCommand): Promise<HarnessTerminalTurnEvent> {
    throw new Error("Harness.answer is not implemented yet");
  }

  protected async interrupt(_command: HarnessInterruptCommand): Promise<HarnessTerminalTurnEvent> {
    throw new Error("Harness.interrupt is not implemented yet");
  }
}
