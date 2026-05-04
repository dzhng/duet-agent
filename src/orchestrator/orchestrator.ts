import type { Skill } from "@mariozechner/pi-coding-agent";
import type { HarnessConfig, HarnessRunOptions } from "../types/config.js";
import type { HarnessRun } from "../types/protocol.js";
import { MemoryStore } from "../memory/store.js";
import {
  loadDiscoveredSkills,
  mergeSkillsByName,
  prepareExplicitSkills,
  readSkillInstructions,
} from "./skills.js";

/**
 * Runtime scaffold around the type-level orchestrator contract.
 *
 * The detailed runtime implementation is intentionally not modeled here while
 * the protocol and state-machine types are still being designed.
 */
export class Orchestrator {
  private readonly memory = new MemoryStore();
  private skills: Skill[] = [];
  private skillsLoaded = false;
  private memoryPersistenceLoaded = false;
  private memoryPersistenceDisposers: Array<() => void> = [];

  constructor(private readonly config: HarnessConfig) {
    for (const module of config.memoryPersistence ?? []) {
      const dispose = module.subscribe?.(this.memory);
      if (dispose) this.memoryPersistenceDisposers.push(dispose);
    }

    if (config.skills) {
      this.skills = prepareExplicitSkills(config.skills);
    }
  }

  dispose(): void {
    for (const dispose of this.memoryPersistenceDisposers.splice(0)) {
      dispose();
    }
  }

  async run(goal: string, _options?: HarnessRunOptions): Promise<HarnessRun> {
    await this.ensureMemoryPersistenceLoaded();
    await this.ensureSkillsLoaded();

    return {
      status: "completed",
      mode: _options?.mode ?? this.config.mode ?? "auto",
      agent: {
        status: "completed",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: goal }],
            timestamp: Date.now(),
          },
        ],
      },
    };
  }

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return [...this.skills];
  }

  private async ensureMemoryPersistenceLoaded(): Promise<void> {
    if (this.memoryPersistenceLoaded) return;
    this.memoryPersistenceLoaded = true;

    for (const module of this.config.memoryPersistence ?? []) {
      await module.load?.(this.memory);
    }
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) return;
    this.skillsLoaded = true;

    const discovered = loadDiscoveredSkills(
      this.config.skillDiscovery,
      this.config.cwd ?? process.cwd(),
    );
    this.skills = mergeSkillsByName(this.skills, discovered);
  }

  private getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.name === skillId);
    if (!skill) return "";
    return readSkillInstructions(skill);
  }
}
