import { exportRoutingTable } from "../model-routing/loader.js";

/** Process-owned effects used by the routing config command. */
export interface ConfigCommandOptions {
  /** Project directory where `.duet/models.json` is written. */
  cwd?: string;
  /** Output sink; defaults to stdout. */
  write?: (text: string) => void;
}

function printConfigHelp(write: (text: string) => void): void {
  write(
    `duet config — Export editable project configuration\n\nUSAGE\n  duet config export [--force]\n`,
  );
}

/** Export the complete built-in routing table without silently overwriting edits. */
export async function runConfigCommand(
  args: string[],
  options: ConfigCommandOptions = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printConfigHelp(write);
    return;
  }
  const [action, ...flags] = args;
  if (action !== "export") throw new Error(`Unknown config action: ${action}`);
  const unknown = flags.find((flag) => flag !== "--force");
  if (unknown) throw new Error(`Unknown config export option: ${unknown}`);
  const exported = await exportRoutingTable({
    cwd: options.cwd ?? process.cwd(),
    force: flags.includes("--force"),
  });
  write(`${exported.path}\n`);
}
