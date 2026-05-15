import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, delimiter } from "node:path";

/**
 * Resolve the path to the ripgrep binary bundled via `@vscode/ripgrep`.
 *
 * Returns `null` (instead of throwing) when the platform-specific optional
 * dependency was not installed — for example, on an unsupported platform or
 * when `npm install --no-optional` was used. Callers fall back to the
 * user's `$PATH` in that case.
 */
async function resolveBundledRgPath(): Promise<string | null> {
  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
    const rgPath = mod.rgPath;
    if (rgPath && existsSync(rgPath)) {
      return rgPath;
    }
  } catch {
    // Optional dep missing for this platform — fall back silently.
  }
  return null;
}

// Cache so we only resolve and probe the filesystem once per process.
let rgDirPromise: Promise<string | null> | undefined;

async function getBundledRgDir(): Promise<string | null> {
  if (!rgDirPromise) {
    rgDirPromise = resolveBundledRgPath().then((rg) => (rg ? dirname(rg) : null));
  }
  return rgDirPromise;
}

/**
 * Wrap a `BashOperations` implementation so the bundled `rg` binary is on
 * `PATH` for every command.
 *
 * We prepend (not append) intentionally: the bundled version is a known-good
 * ripgrep that the agent has been tested against, so we want it to win over
 * any older system install the user happens to have on PATH. Power users who
 * need a different `rg` can shell out to the absolute path explicitly.
 */
export function withBundledRipgrep(base: BashOperations): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const rgDir = await getBundledRgDir();
      if (!rgDir) {
        return base.exec(command, cwd, options);
      }
      const baseEnv = options.env ?? process.env;
      const currentPath = baseEnv.PATH ?? process.env.PATH ?? "";
      // Avoid duplicating the entry on repeated calls.
      const alreadyPresent = currentPath.split(delimiter).some((segment) => segment === rgDir);
      const nextPath = alreadyPresent ? currentPath : `${rgDir}${delimiter}${currentPath}`;
      return base.exec(command, cwd, {
        ...options,
        env: { ...baseEnv, PATH: nextPath },
      });
    },
  };
}
