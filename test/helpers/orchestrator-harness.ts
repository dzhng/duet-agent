import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { AgentStatus, CommLayer, CommMessage } from "../../src/types/comm.js";

export class NullComm implements CommLayer {
  sent: CommMessage[] = [];
  statuses: AgentStatus[] = [];

  async send(message: CommMessage): Promise<void> {
    this.sent.push(message);
  }

  async receive(): Promise<CommMessage> {
    throw new Error("NullComm does not receive messages");
  }

  onMessage(): () => void {
    return () => {};
  }

  async sendStatus(status: AgentStatus): Promise<void> {
    this.statuses.push(status);
  }
}

const unusedModel = {} as Model<any>;

export interface TestSkillInput {
  name: string;
  description: string;
  body?: string;
}

export interface TestOrchestratorApp {
  orchestrator: Orchestrator;
  addProjectSkill(input: TestSkillInput): Promise<string>;
  addGlobalSkill(input: TestSkillInput): Promise<string>;
  cleanup(): Promise<void>;
}

export function createTestOrchestrator(): TestOrchestratorApp {
  const root = process.cwd();
  const orchestrator = new Orchestrator({
    orchestratorModel: unusedModel,
    defaultSubAgentModel: unusedModel,
    cwd: root,
    comm: new NullComm(),
  });

  const createdPaths: string[] = [];

  return {
    orchestrator,
    addProjectSkill: (input) => writeSkill(join(root, ".agents", "skills"), input, createdPaths),
    addGlobalSkill: (input) =>
      writeSkill(join(homedir(), ".agents", "skills"), input, createdPaths),
    cleanup: async () => {
      await Promise.all(createdPaths.map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}

async function writeSkill(
  root: string,
  input: TestSkillInput,
  createdPaths: string[],
): Promise<string> {
  const skillDir = join(root, input.name);
  createdPaths.push(skillDir);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(
    skillPath,
    `---
name: ${input.name}
description: ${input.description}
---

${input.body ?? `# ${input.name}`}
`,
  );
  return skillPath;
}
