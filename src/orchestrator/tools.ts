import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import type {
  Sandbox,
} from "../core/types.js";

interface ToolDeps {
  sandbox: Sandbox;
  allowedActions: string[];
}

/**
 * Create the tool set for a sub-agent.
 *
 * The coding primitives intentionally come from pi's coding-agent package so
 * this scaffold uses the same default tool code: read, bash, edit, and write.
 */
export function createTools(deps: ToolDeps): AgentTool[] {
  const { sandbox, allowedActions } = deps;
  const cwd = (sandbox as unknown as { rootDir?: string }).rootDir ?? process.cwd();
  const allTools = createCodingTools(cwd);
  const toolsByName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

  // Filter to allowed actions only
  if (allowedActions.length > 0 && !allowedActions.includes("*")) {
    const filtered: AgentTool[] = [];
    for (const action of allowedActions) {
      const tool = toolsByName[toCodingToolName(action)];
      if (tool) {
        filtered.push(tool);
      }
    }
    return filtered;
  }

  return allTools;
}

function toCodingToolName(action: string): string {
  switch (action) {
    case "readFile":
      return "read";
    case "writeFile":
      return "write";
    default:
      return action;
  }
}
