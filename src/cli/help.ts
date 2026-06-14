import { DEFAULT_DUET_ENV_FILE, SUPPORTED_API_KEYS } from "./shared.js";

/**
 * How many trailing user-turn exchanges to render when resuming a session.
 * Each exchange is the user prompt plus the assistant reply (text, reasoning,
 * and tool blocks) that followed it; assistant blocks before the first user
 * message in the kept window are dropped along with everything older.
 */
export const DEFAULT_RESUME_HISTORY_MESSAGES = 5;

export function printRunHelp(packageName: string): void {
  console.log(`
duet — An opinionated full-stack agent runner

USAGE
  duet [options] [prompt]
  duet login [--no-browser] [--skip-skill-sync]
  duet env [--env-file <path>] [--import [path]|--keys]
  duet skills [--workdir <path>]
  duet memory [--db <path>]
  duet send-feedback [--file <path>] [text...]
  duet upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | duet

COMMANDS
  login                    Sign in via browser; saves DUET_API_KEY and syncs default skills (recommended)
  env                      Manually create or update the shared duet env file with provider API keys
  skills                   List installed skills + collisions as JSON
  memory                   Open a TUI to view, edit, and delete observational memories (alias: memories)
  send-feedback            Send free-form markdown feedback to the Duet team
  upgrade                  Upgrade the global ${packageName} installation

OPTIONS
  -m, --model <name>       TurnRunner model override
  --memory-model <name>    Observational memory model (default inferred from provider env)
  --provider <name>        Pin the provider and use its catalog default model.
                            Accepts: duet, vercel, openrouter, anthropic, openai.
                            Mutually exclusive with --model / --memory-model.
  -i, --incognito          Keep memory in-process; do not read or write durable memory
  --db <path>              Memory database path (default: ~/.duet/memory.db); ignored under --incognito
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --resume-history-messages <n>
                            Replay the last n user-turn exchanges from the prior session in the TUI (default: ${DEFAULT_RESUME_HISTORY_MESSAGES})
  --system-prompt <text>   Additional system instructions for the runner
  --system-prompt-file <path>
                            Load a file into the system prompt; repeatable
  --no-system-prompt-files Disable default AGENTS.md system prompt loading
  --env-file <path>        Shared env file to load after <workdir>/.env (default: ${DEFAULT_DUET_ENV_FILE})
  --no-auto-upgrade         Skip the auto-upgrade probe for this run (also: DUET_NO_AUTO_UPGRADE=1)
  --no-skill-sync           Skip the on-load default-skill sync
  --rpc                     Bare turn-runner control surface. Reads newline-delimited TurnRunnerCommand
                            JSON from stdin and writes TurnEvent JSON to stdout. The first command must
                            be "start"; the process exits after the single turn reaches its terminal
                            event. Bypasses session persistence entirely.
  -v, --version            Print the installed duet version and exit
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation. Type @ followed by a
  filename to insert a repo-relative path into the prompt.

MODELS
  Prefer shorthands like opus-4.8, opus-4.7, sonnet-4.6, haiku-4.5, and gpt-5.5.
  They map to the first configured provider that supports that model.
  Full provider:modelId syntax is also supported, e.g. anthropic:claude-opus-4-7.
  If omitted, duet infers a default from ANTHROPIC_API_KEY,
  DUET_API_KEY, AI_GATEWAY_API_KEY, OPENROUTER_API_KEY, or
  OPENAI_API_KEY after loading <workdir>/.env and the shared duet env file.

  duet-gateway: routes through the Duet gateway proxy
  (https://duet.so/api/v1/ai-gateway by default; override the app origin
  via DUET_APP_BASE_URL). It mirrors vercel-ai-gateway's model catalog
  and authenticates with DUET_API_KEY.

EXAMPLES
  duet "build a REST API with Express and TypeScript"
  duet -m gpt-5.5 "analyze the performance of our test suite"
  duet --memory-model sonnet-4.6 "summarize this repo"
  duet --provider openai "explain this codebase"
  duet --provider duet "refactor the auth module"
  duet -m opus-4.7 "refactor the auth module"
  duet --system-prompt "Prefer concise answers." "review this repo"
  duet --system-prompt-file TEAM.md "review this repo"
  duet --env-file ~/.config/duet/env "review this repo"
  duet --workdir ./my-project "refactor the auth module"
  duet --resume session_abc123 --workdir ./my-project
  duet login
  duet env
  duet memory
  duet train ./docs/my-project
  duet send-feedback "the TUI flickers when..."
  duet upgrade
`);
}

export function printLoginHelp(): void {
  console.log(`
duet login — Sign in via browser and sync default skills

USAGE
  duet login [--env-file <path>] [--no-browser] [--skip-skill-sync]

Opens a browser window pointed at the Duet web app, waits for the user to
confirm, then writes the org's DUET_API_KEY to the shared env file. After
auth, fetches and writes the latest default skills to ~/.duet/skills.

OPTIONS
  --env-file <path>        Env file to write the API key to (default: ${DEFAULT_DUET_ENV_FILE})
  --no-browser             Print the auth URL instead of opening a browser
  --skip-skill-sync        Skip the post-login default skills sync
  -h, --help               Show this help

SKILL SYNC
  Mirrors the sandbox protocol: hashes the rendered skill payload and only
  rewrites ~/.duet/skills when the hash differs from ~/.duet/.skills-hash.

OVERRIDES
  Set DUET_APP_BASE_URL (e.g. https://staging.duet.so) to re-point both the
  AI gateway provider and the CLI auth/sync endpoints at a non-production
  deployment.
`);
}

export function printEnvHelp(): void {
  console.log(`
duet env — Create or update a shared duet env file

USAGE
  duet env [--env-file <path>] [--import [path]|--keys]

Prefer \`duet login\` for the standard setup flow. Use \`duet env\` when you
want manual control over which provider API keys land in the shared env file.

By default, env only prints this help. Choose --import to copy
provider keys from cwd .env or a provided env file, or --keys to paste keys interactively.

OPTIONS
  --env-file <path>        Env file to write (default: ${DEFAULT_DUET_ENV_FILE})
  -i, --import [path]      Import cwd .env, or import the provided env file
  --keys                   Prompt for supported provider API keys
  -h, --help               Show this help

SUPPORTED KEYS
  ${SUPPORTED_API_KEYS.join(", ")}
`);
}

export function printSkillsHelp(): void {
  console.log(`
duet skills — List installed skills as JSON

USAGE
  duet skills [--workdir <path>]

OPTIONS
  -w, --workdir <path>     Working directory for project-local skills (default: cwd)
  -h, --help               Show this help

OUTPUT
  Prints a JSON object with two keys:
    skills       Array of installed skills. Each entry has:
                   name         Skill name
                   description  Skill description (from frontmatter)
                   path         Absolute path to the skill directory
                   scope        "user", "project", "temporary", or "builtin"
    collisions   Array of name conflicts resolved during discovery.
                 Each entry has: name, winnerPath, loserPath.
`);
}

export function printMemoryHelp(): void {
  console.log(`
duet memory — Browse, edit, and delete observational memories

USAGE
  duet memory [--db <path>] [--wait <seconds>]
  duet memory reflect [options]

ALIASES
  duet memories

SUBCOMMANDS
  reflect                  Condense old global observations into reflection rows
                           (run \`duet memory reflect --help\` for reflect-specific options)

OPTIONS
  --db <path>              Memory database path (default: ~/.duet/memory.db)
  --wait <seconds>         Seconds to wait for the cross-process open-lock when a peer
                           duet process is holding it (default: 30; 0 fails immediately)
  -h, --help               Show this help

KEYS
  ↑ / ↓                    Move selection
  e                        Edit selected memory in $EDITOR
  d                        Delete selected memory
  q / Esc                  Quit
`);
}

export function printMemoryReflectHelp(): void {
  console.log(`
duet memory reflect — Condense old global observations into reflection rows

USAGE
  duet memory reflect [--db <path>] [--dry-run] [--min-age-days <n>]
                      [--target-tokens <n>] [--model <name>]
                      [--effective-context <tokens>] [--wait <seconds>]

DESCRIPTION
  Walks the durable memory store and folds older content into atomic
  global reflection rows that downstream recall can rank, decay, and
  refresh independently.

  Eligible input includes raw observations AND single-blob local
  reflections (the per-session reflections written automatically when a
  session crosses its local memory budget). Global reflection rows from
  prior \`duet memory reflect\` runs are preserved verbatim — re-reflecting
  them would only collapse them into vaguer text. Fresh rows younger
  than --min-age-days (default 3) are also preserved so resumed sessions
  keep their recent local memory intact.

  Batches are packed up to one reflection trigger's worth of tokens and
  sequenced chronologically across sessions for cross-session dedup. Use
  --dry-run to preview without writing.

OPTIONS
  --db <path>              Memory database path (default: ~/.duet/memory.db)
  --dry-run                Print the reflected log without writing it back
  --min-age-days <n>       Skip observations newer than this many days
                           (default: 3)
  --target-tokens <n>      Override the reflected log token budget per batch
  --model <name>           Memory model used for reflection (default: env / CLI default)
  --effective-context <n>  Effective context window used to derive memory budgets
                           (default: 200000)
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
`);
}

export function printTrainHelp(): void {
  console.log(`
duet train — Ingest a project corpus into one durable memory observation

USAGE
  duet train <folder> [--slug <name>] [--model <name>] [--db <path>] [--wait <seconds>]
  duet train list [--db <path>] [--json]
  duet train show <slug> [--db <path>] [--json]
  duet train update <slug> --content-file <path> [--db <path>] [--json]
  duet train delete <slug> [--db <path>] [--json]

DESCRIPTION
  Launches a duet agent with the corpus folder as its working directory.
  The agent reads the corpus using its native file-reading tools (any
  format the duet agent normally reads — markdown, plain text, CSVs, PDFs,
  spreadsheets, source code) and writes a single handoff file at the
  corpus root:

    .duet-train.json  — structured handoff with headline + observation.

  'train' then persists the synthesis into ~/.duet/memory.db as a manual
  (user-curated) row (tagged 'train' and 'train:<slug>'), archives the
  corpus under ~/.duet/train/<memory-id>/, removes the handoff file, and
  prints the observation content to stdout so what you see is what landed
  in memory.

  The management subcommands all key on the user-facing <slug> (resolved
  to the underlying row internally):
    list    — every training (one row per slug), joined to its archive
              manifest to show slug, headline, model, file count, date,
              and memory id.
    show    — the same metadata plus the full synthesized observation text.
    update  — replace just the observation text from --content-file, in
              place; the corpus archive is preserved untouched. Use this to
              hand-correct a memory without re-running synthesis (re-running
              'duet train <folder> --slug <slug>' is the re-synthesis path).
    delete  — permanently remove the row and its corpus archive.
  Pass --json to any of them for machine-readable output.

  Subsequent runs against the same slug replace the prior row in place,
  so the memory pool does not bloat. Writing the row as a manual row
  earns it a ranking boost in the memory pack (via manualBias) and exempts
  it from 'duet memory reflect' compaction; deleting it via 'duet memory'
  also removes its archive. Note: train loads the corpus folder's .env (for provider
  credentials), so check folders you did not author before training.

OPTIONS
  --slug <name>            Override the corpus slug (default: sanitized folder basename)
  --model <name>           Model used by the synthesis sub-agent (default: same resolution as 'duet run')
  --db <path>              Memory database path (default: ~/.duet/memory.db)
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help

EXAMPLES
  duet train ./docs/my-project
  duet train ./research --slug acme-research --model sonnet-4.6
  duet train list
  duet train list --json
  duet train show acme-research
  duet train update acme-research --content-file ./edited.md
  duet train delete acme-research
`);
}

export function printSendFeedbackHelp(): void {
  console.log(`
duet send-feedback — Send free-form markdown feedback to the Duet team

USAGE
  duet send-feedback [text...]
  duet send-feedback --file <path>
  echo "feedback" | duet send-feedback

Submits a piece of markdown feedback to the Duet team's triage queue. The
endpoint is public — no API key required. With no input, drops you into an
interactive prompt; submit an empty line to send.

OPTIONS
  -f, --file <path>        Read feedback content from a file
  -h, --help               Show this help
`);
}

export function printUpgradeHelp(packageName: string): void {
  console.log(`
duet upgrade — Upgrade the global ${packageName} installation

USAGE
  duet upgrade [--manager npm|bun|pnpm|yarn] [--version <version>] [--force]

OPTIONS
  --manager <name>         Package manager to use (default: detected, fallback: npm)
  --version <version>      Install an exact version instead of npm's latest dist-tag
  --dry-run                Print the upgrade command without running it
  --force                  Upgrade even if another duet CLI is using the memory db
                           (risks corrupting the db while npm rewrites node_modules)
  -h, --help               Show this help
`);
}
