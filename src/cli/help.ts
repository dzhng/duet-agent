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
  duet login [--no-browser]
  duet connect [--status [--json] | --disconnect <provider>]
  duet env [--env-file <path>] [--import [path]|--keys]
  duet skills [--workdir <path>]
  duet memory [--db <path>] [--json] [filters]
  duet model -m <model> [--type text|image|video] [prompt]
  duet send-feedback [--file <path>] [text...]
  duet upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | duet

COMMANDS
  login                    Sign in via device flow; saves a DUET_API_KEY (recommended)
  connect                  Show or remove connected ChatGPT and GitHub Copilot subscriptions
  env                      Manually create or update the shared duet env file with provider API keys
  skills                   List installed skills + collisions as JSON
  memory                   Browse memories in a TUI, or query them with --json/filters (alias: memories)
  model                    Call a gateway model directly (text/image/video) via the AI SDK
  route                    Probe the live virtual-model classifier (duet route "<prompt>")
  config export            Write the built-in routing table to .duet/models.json for tweaking
  send-feedback            Send free-form markdown feedback to the Duet team
  upgrade                  Upgrade the global ${packageName} installation

OPTIONS
  -m, --model <name>       Virtual tier (frontier|balanced|economy) or concrete model pin
  --memory-model <name>    Observational memory model (default inferred from provider env)
  --provider <name>        Pin the provider and use its catalog default model.
                            Accepts: duet, vercel, openrouter.
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
  --rpc                     Bare turn-runner control surface. Reads newline-delimited RpcRunnerCommand
                            JSON from stdin and writes RpcEvent JSON to stdout. Prompt, answer, and wake
                            commands require requestId and emit command_accepted after runner delivery.
                            The first command must be "start"; the process exits after the single turn
                            reaches its terminal event. Bypasses session persistence entirely.
  --session <id>            (--rpc only) Attribute memory written during the process to this caller-owned
                            session id. One RPC process is one logical session; omit to write with no id.
  -v, --version            Print the installed duet version and exit
  -h, --help               Show this help

INTERACTIVE
  In a TTY, duet keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation. Type @ followed by a
  filename to insert a repo-relative path into the prompt.

MODELS
  The default is the routed frontier tier. Use frontier, balanced, or economy
  to select a routing policy, or a concrete shorthand to bypass routing and pin.
  Concrete names include opus, sonnet, haiku, and sol (versionless families), or versioned forms like opus-4.8.
  They map to the first configured router that supports that model.
  Full provider:modelId syntax is also supported, e.g. duet:anthropic/claude-opus-4.8.
  --provider pins that provider's concrete default; the memory model remains concrete.

  duet-gateway: routes through the Duet gateway proxy
  (https://gateway.duet.so by default; override via DUET_GATEWAY_BASE_URL).
  It mirrors vercel-ai-gateway's model catalog and authenticates with
  DUET_API_KEY.

EXAMPLES
  duet "build a REST API with Express and TypeScript"
  duet -m sol "analyze the performance of our test suite"
  duet --memory-model sonnet-4.6 "summarize this repo"
  duet --provider openrouter "explain this codebase"
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
  duet model -m openai/gpt-5.6-sol "write a haiku about gateways"
  duet model -m black-forest-labs/flux-1.1-pro -o art.png "a fox in snow"
  duet train ./docs/my-project
  duet send-feedback "the TUI flickers when..."
  duet upgrade
`);
}

export function printLoginHelp(): void {
  console.log(`
duet login — Sign in via device flow

USAGE
  duet login [--env-file <path>] [--no-browser]

Requests a device code, prints the user code and verification URL, waits for
approval, then writes the selected workspace's DUET_API_KEY to the shared env
file. You choose the workspace in the browser during approval.

OPTIONS
  --env-file <path>        Env file to write the API key to (default: ${DEFAULT_DUET_ENV_FILE})
  --no-browser             Print the verification URL instead of opening a browser
  -h, --help               Show this help

OVERRIDES
  Set DUET_API_BASE_URL (e.g. https://api-staging.duet.so) to re-point device
  login. Model traffic uses DUET_GATEWAY_BASE_URL.
`);
}

export function printConnectHelp(): void {
  console.log(`
duet connect — Manage connected model-provider subscriptions

USAGE
  duet connect <chatgpt|copilot> [--device-code] [--no-browser] [--json]
  duet connect --status [--json]
  duet connect --disconnect <chatgpt|copilot> [--json]

OPTIONS
  --device-code            Force device-code login (the only VM-valid mode)
  --no-browser             Do not open the verification URI automatically
  --status                 List connected providers
  --json                   Stream login/disconnect events as NDJSON; status stays an envelope
  --disconnect <provider>  Remove stored credentials for chatgpt or copilot
  -h, --help               Show this help
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
duet memory — Browse, query, edit, and delete observational memories

USAGE
  duet memory [--db <path>] [--wait <seconds>]
  duet memory [--json] [--type <kind>] [--priority <level>] [--source <origin>]
              [--session <id>] [--from <date>] [--to <date>]
  duet memory reflect [options]

ALIASES
  duet memories

DESCRIPTION
  Bare \`duet memory\` opens an interactive TUI to browse, edit, and delete
  durable observations. Passing --json or any filter flag instead runs a
  non-TUI, scriptable query: it prints a flat, chronological list (newest
  createdAt first) of the matching observations. In table mode each row shows
  a computed \`score\` matching the runner's global-pack ranking; --json emits
  a machine-readable array of canonical memory objects (ISO timestamps, flat
  \`source\` string, echoed \`sessionId\`, and that score as \`packScore\`).

  Examples:
    duet memory
    duet memory --json --type reflection --from 2026-06-26
    duet memory --json --from "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)"

SUBCOMMANDS
  add                      Write a single user-added note memory
                           (run \`duet memory add --help\` for add-specific options)
  recall <query>           Hybrid semantic + keyword search over durable memory,
                           the same pipeline the runner's recall_memory tool uses
                           (run \`duet memory recall --help\` for recall-specific options)
  reflect                  Condense old global observations into reflection rows
                           (run \`duet memory reflect --help\` for reflect-specific options)

QUERY OPTIONS
  --json                   Emit a JSON array instead of a table (also enables query mode)
  --type <kind>            Filter by kind: observation | reflection | note | manual
  --kind <kind>            Alias for --type
  --priority <level>       Filter by priority: high | medium | low
  --source <origin>        Filter by source: user | agent | system | api | import
  --session <id>           Filter to rows authored by this session id
  --from <date>            Inclusive lower bound on createdAt. Accepts
                           YYYY-MM-DD (start of day UTC) or YYYY-MM-DDTHH:MM:SS (UTC)
  --to <date>              Inclusive upper bound on createdAt. Accepts
                           YYYY-MM-DD (end of day UTC) or YYYY-MM-DDTHH:MM:SS (UTC)

OPTIONS
  --db <path>              Memory database path (default: ~/.duet/memory.db)
  --wait <seconds>         Seconds to wait for the cross-process open-lock when a peer
                           duet process is holding it (default: 30; 0 fails immediately)
  -h, --help               Show this help

KEYS (TUI)
  ↑ / ↓                    Move selection
  e                        Edit selected memory in $EDITOR
  d                        Delete selected memory
  q / Esc                  Quit
`);
}

export function printMemoryAddHelp(): void {
  console.log(`
duet memory add — Write a single user-added note memory

USAGE
  duet memory add [options] [--store <folder> | --db <file>] <content>
  echo "<content>" | duet memory add [options] [--store <folder> | --db <file>]

DESCRIPTION
  Stores a note in exactly one backend. With no backend flag, the note is
  written to the nearest ancestor .agents/memories directory (created on
  demand). --store writes a markdown memory file; --db retains the legacy
  observational-row behavior. Passing more than one backend is a usage error.

  Content comes from the positional arguments, or from stdin when none are
  given so longer memories can be piped in.

OPTIONS
  --priority <level>       high, medium, or low (default: medium)
  --source <origin>        user, agent, system, api, or import (default: user)
  --session <id>           Stamp the row's authoring session; omit to leave it
                           global/unattributed
  --tag <tag>              Attach a label; repeat to add several
  --store <folder>         Memory-file directory to write
  --db <file>              PGlite file to write instead of a memory store
  --json                   Emit the stored memory as JSON instead of the
                           confirmation line (DB rows include packScore;
                           file rows include slug + store provenance)
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
`);
}

export function printMemoryRecallHelp(): void {
  console.log(`
duet memory recall — Hybrid semantic + keyword search over durable memory

USAGE
  duet memory recall [options] [--query <q> | <query...>]

DESCRIPTION
  Searches ~/.duet/memory.db with the exact pipeline the runner's
  recall_memory tool uses: vector (embedding) search and keyword search run
  in parallel and merge via Reciprocal Rank Fusion, so fuzzy paraphrases and
  exact tokens (proper nouns, IDs, code symbols) both match. Results print
  best-match first.

  Embeddings use the Duet endpoint (DUET_API_KEY). When it is unavailable the
  vector path is skipped and recall falls back to keyword-only, flagged in the
  output. --expand adds model-generated paraphrases before fusion for vague
  queries, at the cost of an extra model call.

  Examples:
    duet memory recall wire byte budget cap
    duet memory recall --expand "how does the gateway race resolve"
    duet memory recall --scope global --session <id> --json qwiklabs

OPTIONS
  --query <q>              Search text (alternative to positional <query>;
                           both are accepted and combine)
  --scope <scope>          session | global | all (default: all).
                           session/global require --session <id>
  --session <id>           Session id to compare against for --scope session/global
  --limit <n>              Maximum fused results to return (default: 8)
  --expand                 Also run model-generated paraphrases before fusion
  --model <name>           Model used for --expand paraphrases (default: cheap CLI memory model)
  --json                   Emit a bare JSON array of canonical memory objects
                           (best-first) with packScore + relevanceScore
  --db <path>              Memory database path (default: ~/.duet/memory.db)
                           This command is DB-only; --store is rejected because
                           store memories are already loaded into agent context
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
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

export function printModelHelp(): void {
  console.log(`
duet model — Call a gateway model directly via the AI SDK

USAGE
  duet model -m <model> [options] [prompt]
  echo "prompt" | duet model -m <model>

DESCRIPTION
  Talks to a model directly through the Vercel AI SDK pointed at the Duet
  gateway, bypassing the agent harness. The request type is inferred from
  the gateway model catalog (language→text, image→image, video→video) and
  can be overridden with --type. Text streams to stdout; image and video
  generations write files and print each path. Auth uses DUET_API_KEY.

OPTIONS
  -m, --model <name>       Gateway model id, e.g. openai/gpt-5.6-sol (required)
  --type text|image|video  Override the catalog-inferred request type
  --image <path>           Input image: vision context (text), edit source
                           (image), or still to animate (video)
  -o, --out <path>         Write output here; image/video auto-name when omitted
  --system <text>          System prompt for text/image-language models
  --size <WxH>             Image size, e.g. 1024x1024
  --aspect <W:H>           Aspect ratio, e.g. 16:9
  --n <count>              Number of outputs to generate
  --seed <int>             Generation seed
  --duration <seconds>     Video length
  --resolution <WxH>       Video resolution, e.g. 1280x720
  --fps <int>              Video frames per second
  --env-file <path>        Shared env file to load after cwd .env
  -h, --help               Show this help

EXAMPLES
  duet model -m openai/gpt-5.6-sol "write a haiku about gateways"
  duet model -m bfl/flux-pro-1.1 -o art.png "a fox in snow"
  duet model -m google/gemini-2.5-flash-image --type image --image src.png "add a hat"
  duet model -m bytedance/seedance-2.0 --type video -o clip.mp4 "slow pan over dunes"
`);
}

export function printTrainHelp(): void {
  console.log(`
duet train — Ingest a project corpus into one durable memory observation

USAGE
  duet train <folder> [--slug <name>] [--model <name>]
             [--store <folder> | --db <file>] [--wait <seconds>]
  duet train list [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  duet train show <slug> [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  duet train update <slug> --content-file <path>
             [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  duet train delete <slug> [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]

DESCRIPTION
  Launches a duet agent with the corpus folder as its working directory.
  The agent reads the corpus using its native file-reading tools (any
  format the duet agent normally reads — markdown, plain text, CSVs, PDFs,
  spreadsheets, source code) and writes a single handoff file at the
  corpus root:

    .duet-train.json  — structured handoff with headline + observation.

  'train' then persists the synthesis into exactly one backend and archives
  the corpus under ~/.duet/train/<memory-id>/. With no backend flag it writes
  a markdown file under the nearest ancestor .agents/memories directory,
  creating that directory when needed. --db retains the legacy manual-row
  behavior. Passing more than one backend to create is a usage error.

  Reads accept repeatable --store and --db flags. Any explicit backend flags
  replace discovery; stores are consulted in flag order before DBs. Without
  flags, reads union inherited stores from cwd toward the filesystem root,
  then ~/.duet/memory.db. Duplicate slugs resolve to the first source, while
  surviving entries are listed newest-first. show/update/delete use that same
  first-source precedence.

  The management subcommands all key on the user-facing <slug> (resolved
  to the underlying row internally):
    list    — every visible store entry or DB training (one row per slug),
              joined to its archive
              manifest to show slug, headline, model, file count, date,
              and memory id.
    show    — the same metadata plus the full synthesized observation text
              and (with --json) the archived files' absolute paths.
    update  — replace just the observation text from --content-file, in
              place; the corpus archive is preserved untouched. Use this to
              hand-correct a memory without re-running synthesis (re-running
              'duet train <folder> --slug <slug>' is the re-synthesis path).
    delete  — permanently remove the row and its corpus archive.
  Pass --json to any of them for machine-readable output.

  Subsequent runs against the same slug replace the prior target entry, so
  the memory pool does not bloat. On --db, the legacy manual row keeps its
  ranking boost and reflection exemption. Note: train loads the corpus
  folder's .env (for provider credentials), so check folders you did not
  author before training.

OPTIONS
  --slug <name>            Override the corpus slug (default: sanitized folder basename)
  --model <name>           Model used by the synthesis sub-agent (default: same resolution as 'duet run')
  --store <folder>         Memory-file directory; repeat on read/manage commands
  --db <file>              PGlite path; repeat on read/manage commands
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
