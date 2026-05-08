import { DEFAULT_DUET_ENV_FILE, SUPPORTED_API_KEYS } from "./shared.js";

export const DEFAULT_RESUME_HISTORY_LINES = 40;

export function printRunHelp(packageName: string): void {
  console.log(`
duet — An opinionated full-stack agent runner

USAGE
  duet [options] [prompt]
  duet login [--no-browser] [--skip-skill-sync]
  duet env [--env-file <path>] [--import [path]|--keys]
  duet skills [--workdir <path>]
  duet memories [--db <path>]
  duet upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | duet

COMMANDS
  login                    Sign in via browser; saves DUET_API_KEY and syncs default skills (recommended)
  env                      Manually create or update the shared duet env file with provider API keys
  skills                   List installed skills as JSON (name, description, path, scope)
  memories                 Open a TUI to view, edit, and delete observational memories
  upgrade                  Upgrade the global ${packageName} installation

OPTIONS
  -m, --model <name>       TurnRunner model override
  --memory-model <name>    Observational memory model (default inferred from provider env)
  --no-memory              Keep memory in-process; do not read or write durable memory
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --resume-history-lines <n>
                            Display up to n prior-session lines in the TUI (default: ${DEFAULT_RESUME_HISTORY_LINES})
  --system-prompt <text>   Additional system instructions for the runner
  --system-prompt-file <path>
                            Load a file into the system prompt; repeatable
  --no-system-prompt-files Disable default AGENTS.md system prompt loading
  --env-file <path>        Shared env file to load after <workdir>/.env (default: ${DEFAULT_DUET_ENV_FILE})
  --json                    Force JSONL event output instead of the TUI
  -v, --version            Print the installed duet version and exit
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation. Type @ followed by a
  filename to insert a repo-relative path into the prompt.

MODELS
  Prefer shorthands like opus-4.7, sonnet-4.6, haiku-4.5, and gpt-5.5.
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
  duet -m opus-4.7 "refactor the auth module"
  duet --system-prompt "Prefer concise answers." "review this repo"
  duet --system-prompt-file TEAM.md "review this repo"
  duet --env-file ~/.config/duet/env "review this repo"
  duet --workdir ./my-project "refactor the auth module"
  duet --resume session_abc123 --workdir ./my-project
  duet login
  duet env
  duet memories
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
  Prints a JSON array of installed skills. Each entry has:
    name         Skill name
    description  Skill description (from frontmatter, raw — no shell expansion)
    path         Absolute path to the skill directory
    scope        "user", "project", or "temporary"
`);
}

export function printMemoriesHelp(): void {
  console.log(`
duet memories — Browse, edit, and delete observational memories

USAGE
  duet memories [--db <path>]

OPTIONS
  --db <path>              Memory database path (default: ~/.duet/memory.db)
  -h, --help               Show this help

KEYS
  ↑ / ↓                    Move selection
  e                        Edit selected memory in $EDITOR
  d                        Delete selected memory
  q / Esc                  Quit
`);
}

export function printUpgradeHelp(packageName: string): void {
  console.log(`
duet upgrade — Upgrade the global ${packageName} installation

USAGE
  duet upgrade [--manager npm|bun|pnpm|yarn] [--version <version>]

OPTIONS
  --manager <name>         Package manager to use (default: detected, fallback: npm)
  --version <version>      Install an exact version instead of npm's latest dist-tag
  --dry-run                Print the upgrade command without running it
  -h, --help               Show this help
`);
}
