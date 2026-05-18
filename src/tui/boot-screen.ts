import { type CliRenderer, type ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { homedir } from "node:os";
import {
  describeUpgradeStatus,
  type UpgradeStatus,
  type UpgradeStatusStream,
} from "../cli/auto-upgrade.js";
import type { Session } from "../session/session.js";
import type { TurnAgentFile } from "../types/protocol.js";
import type { AutocompleteController } from "./autocomplete-controller.js";
import { BUILT_IN_SLASH_COMMAND_ITEMS } from "./slash-commands.js";
import { refreshSidebarFromSession } from "./session-subscription.js";
import type { Sidebar } from "./sidebar.js";
import type { StarterSection } from "./starter-section.js";
import { DUET_BANNER_LINES_COMPACT } from "./history.js";
import { COLORS } from "./theme.js";

/**
 * Inputs to the boot intro renderer. Everything is read-only — the boot
 * screen is a one-shot painter that runs after chrome is constructed and
 * before the first turn dispatches.
 */
export interface BootScreenDeps {
  renderer: CliRenderer;
  transcript: ScrollBoxRenderable;
  appendLine(content: string, fg: string): void;
  packageName: string;
  packageVersion: string;
  workDir: string;
  modelName: string;
  memoryModelName: string;
  upgradeStatus$?: UpgradeStatusStream;
  /**
   * Present only on fresh (non-resume) mounts. `runTui` creates the
   * StarterSection lazily and leaves it undefined on resume mounts, so the
   * starter chrome is skipped without needing a separate resume flag.
   */
  starters?: StarterSection;
}

/**
 * Paints the boot banner, header, optional upgrade-status line, agent-file
 * summary, and (on fresh boots) mounts the starter chrome.
 */
export function renderSetupIntro(
  deps: BootScreenDeps,
  skills: ReadonlyArray<{ name: string }>,
  agentFiles: readonly TurnAgentFile[],
): void {
  // Compact 3-row wordmark. The full DUET_BANNER_LINES is ~6 rows tall and
  // pushed the starter list off-screen on small terminals; this one keeps
  // the brand mark visible while leaving room for the starter prompts to
  // land above the fold.
  for (const line of DUET_BANNER_LINES_COMPACT) deps.appendLine(line, COLORS.status);
  deps.appendLine(" ", COLORS.hint);
  deps.appendLine(" ", COLORS.hint);
  // One-line header. Keeps cwd/model context visible without burning another
  // five rows. Provenance (env/file source) is intentionally dropped here —
  // surface it via /whoami later.
  deps.appendLine(formatBootHeader(deps), COLORS.status);

  if (deps.upgradeStatus$) {
    subscribeUpgradeStatus(deps);
  }

  // Only mention agent files when one is actually loaded; "[agent file]
  // none" is noise on every empty boot.
  if (agentFiles.length > 0) {
    deps.appendLine(`[agent file] ${agentFiles.map((file) => file.name).join(", ")}`, COLORS.hint);
  }

  // Resume mounts leave `deps.starters` undefined so we skip the "what
  // should we work on today?" menu — the user explicitly asked to drop
  // back into a known conversation.
  if (deps.starters) {
    deps.starters.mount(skills);
  }
}

function subscribeUpgradeStatus(deps: BootScreenDeps): void {
  const stream = deps.upgradeStatus$;
  if (!stream) return;
  // Lazy construction on the first status that has human-readable text.
  // Statuses without text (current/locked/skipped) skip the constructor
  // entirely; constructing eagerly would allocate a native text buffer
  // against the renderer that we would never `destroy()` on the silent path.
  //
  // `subscribe()` replays the latest status synchronously, so the handler
  // runs before `subscribe()` returns its unsubscribe handle. We set a
  // `done` flag from inside the handler and tear down after `subscribe()`
  // returns; subsequent (async) terminal statuses unsubscribe inline via
  // the real handle.
  let upgradeLine: TextRenderable | undefined;
  let done = false;
  let unsubscribe = (): void => {};
  const handle = (status: UpgradeStatus): void => {
    const text = describeUpgradeStatus(deps.packageName, status);
    if (!text) {
      if (upgradeLine) {
        deps.transcript.remove(upgradeLine.id);
        upgradeLine.destroy();
        upgradeLine = undefined;
      }
      // Terminal statuses with no human-readable form (current, locked,
      // skipped) close the subscription so we stop reacting.
      if (status.kind !== "checking") {
        done = true;
        unsubscribe();
      }
      return;
    }
    const fg = status.kind === "failed" ? COLORS.error : COLORS.system;
    if (!upgradeLine) {
      upgradeLine = new TextRenderable(deps.renderer, { content: `[update] ${text}`, fg });
      deps.transcript.add(upgradeLine);
    } else {
      upgradeLine.content = `[update] ${text}`;
      upgradeLine.fg = fg;
    }
    if (status.kind === "upgraded" || status.kind === "failed") {
      done = true;
      unsubscribe();
    }
  };
  unsubscribe = stream.subscribe(handle);
  if (done) unsubscribe();
}

export function formatBootHeader(deps: {
  packageVersion: string;
  workDir: string;
  modelName: string;
  memoryModelName: string;
}): string {
  const cwdLabel = shortenCwd(deps.workDir);
  return `DUET AGENT  v${deps.packageVersion}   ·   ${cwdLabel}   ·   ${deps.modelName} + ${deps.memoryModelName}`;
}

/**
 * One-shot boot intro: loads skills + agent files from the session, seeds
 * the autocomplete index, paints the banner/header/agent-file line, and
 * refreshes the sidebar from the session's current state snapshot.
 */
export async function renderBootScreen(deps: {
  renderer: CliRenderer;
  transcript: ScrollBoxRenderable;
  appendLine(content: string, fg: string): void;
  session: Session;
  sidebar: Sidebar;
  autocomplete: AutocompleteController;
  starters?: StarterSection;
  packageName: string;
  packageVersion: string;
  workDir: string;
  modelName: string;
  memoryModelName: string;
  upgradeStatus$?: UpgradeStatusStream;
}): Promise<void> {
  const [skills, agentFiles] = await Promise.all([
    deps.session.getSkills(),
    deps.session.getResolvedAgentFiles(),
  ]);
  deps.autocomplete.setSkillItems([
    ...BUILT_IN_SLASH_COMMAND_ITEMS,
    ...skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.baseDir,
      group: "skills" as const,
    })),
  ]);
  deps.autocomplete.refresh();
  renderSetupIntro(
    {
      renderer: deps.renderer,
      transcript: deps.transcript,
      appendLine: deps.appendLine,
      packageName: deps.packageName,
      packageVersion: deps.packageVersion,
      workDir: deps.workDir,
      modelName: deps.modelName,
      memoryModelName: deps.memoryModelName,
      upgradeStatus$: deps.upgradeStatus$,
      starters: deps.starters,
    },
    skills,
    agentFiles,
  );
  refreshSidebarFromSession({ session: deps.session, sidebar: deps.sidebar });
}

export function shortenCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}
