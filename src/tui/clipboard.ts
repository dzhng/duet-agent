/**
 * Write-side clipboard helpers used by the `/copy` slash command and the
 * platform copy keystroke (Cmd+C on macOS, Ctrl+Shift+C elsewhere). The
 * TUI prefers OpenTUI's built-in OSC 52 path
 * (`renderer.copyToClipboardOSC52`) because it works over SSH, tmux, and
 * any modern terminal that advertises OSC 52 support. This module is the
 * fallback for terminals that do not — we shell out to platform-native
 * writers (pbcopy / wl-copy / xclip / xsel / clip.exe) one at a time.
 *
 * Each tool accepts text on stdin so we never have to escape user content
 * into a shell command. If every path fails we surface the last error so
 * the caller can tell the user what to install (e.g. `xclip` on Linux).
 */

import { spawn } from "node:child_process";

/** Result of a write attempt. `error` is undefined on success. */
export interface ClipboardWriteResult {
  /** True when one of the candidate commands accepted stdin and exited 0. */
  ok: boolean;
  /** Name of the command that succeeded, e.g. "pbcopy"; undefined on failure. */
  via?: string;
  /** Last error encountered when every candidate failed. */
  error?: string;
}

/**
 * Pipe `text` into the system clipboard via a platform-native CLI writer.
 * Tries writers in order and returns as soon as one succeeds. Never throws
 * — surfaces failure via the returned `ClipboardWriteResult` so callers can
 * render the exact reason in the transcript without wrapping in try/catch.
 *
 * Used as a fallback when OSC 52 is unavailable. Callers should prefer
 * `renderer.copyToClipboardOSC52` first for cross-terminal correctness.
 */
export async function writeClipboardText(text: string): Promise<ClipboardWriteResult> {
  const candidates = clipboardWriteCandidates();
  let lastError: string | undefined;

  for (const candidate of candidates) {
    try {
      await pipeToCommand(candidate.cmd, candidate.args, text);
      return { ok: true, via: candidate.cmd };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    error: lastError ?? "no clipboard writer available",
  };
}

interface ClipboardWriter {
  cmd: string;
  args: string[];
}

/**
 * Ordered list of writers the current platform should try. macOS prefers the
 * native `pbcopy`; Linux tries Wayland's `wl-copy` first since it works on
 * most modern desktops, then falls back to `xclip` and `xsel` for X11; other
 * platforms (assumed Windows) try `clip.exe` and PowerShell's
 * `Set-Clipboard`. Order matters: the first command that exits 0 wins, so
 * the most reliable / native option goes first.
 */
function clipboardWriteCandidates(): ClipboardWriter[] {
  if (process.platform === "darwin") {
    return [{ cmd: "pbcopy", args: [] }];
  }
  if (process.platform === "win32") {
    return [
      { cmd: "clip.exe", args: [] },
      // PowerShell fallback covers PowerShell-only environments and WSL
      // shells that have lost `clip.exe` from PATH.
      { cmd: "powershell", args: ["-NoProfile", "-Command", "$input | Set-Clipboard"] },
    ];
  }
  // Linux / BSD / other unixes. wl-copy works on Wayland sessions; xclip
  // and xsel cover X11. clip.exe is included so WSL users with the Windows
  // path on $PATH still get a working clipboard without configuring xclip.
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
    { cmd: "clip.exe", args: [] },
  ];
}

/**
 * Spawn `cmd` with `args`, write `text` to its stdin, and resolve when it
 * exits 0. Rejects on non-zero exit, spawn error (e.g. command not found),
 * or any stdin write failure so the outer loop can fall through to the next
 * candidate.
 */
function pipeToCommand(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    child.on("error", (error) => {
      reject(error);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() || `exit ${code}`;
        reject(new Error(`${cmd} failed: ${detail}`));
      }
    });

    child.stdin.on("error", reject);
    child.stdin.end(text, "utf8");
  });
}
