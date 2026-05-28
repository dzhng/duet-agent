#!/usr/bin/env bun

/**
 * duet CLI executable entry point.
 *
 * This file stays deliberately thin: the published `duet` bin resolves here so
 * that `duet -v` / `duet --version` on the default run command can print the
 * version without paying the ~0.3s cost of evaluating the full run/session/TUI
 * import graph that `./cli.js` pulls in statically. Every other invocation
 * defers to `runCli`, which owns the real subcommand dispatch.
 */

import packageJson from "../package.json" with { type: "json" };

const args = process.argv.slice(2);

// A leading `-v`/`--version` is the version invocation; named subcommands and
// `--rpc` own their own flag parsing, so only the first token short-circuits.
if (args[0] === "-v" || args[0] === "--version") {
  console.log(packageJson.version);
} else {
  const { runCli } = await import("./cli.js");
  await runCli();
}
