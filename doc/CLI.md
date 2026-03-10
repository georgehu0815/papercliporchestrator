# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm paperclipai --help
```
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts "--help"

Usage: paperclipai [options] [command]

Paperclip CLI — setup, diagnose, and configure your instance

Options:
  -V, --version                      output the version number
  -h, --help                         display help for command

Commands:
  onboard [options]                  Interactive first-run setup wizard
  doctor|--fix [options]             Run diagnostic checks on your Paperclip setup
  env [options]                      Print environment variables for deployment
  configure [options]                Update configuration sections
  db:backup [options]                Create a one-off database backup using current config
  allowed-hostname [options] <host>  Allow a hostname for authenticated/private mode access
  run [options]                      Bootstrap local setup (onboard + doctor) and run Paperclip
  heartbeat                          Heartbeat utilities
  context                            Manage CLI client context profiles
  company                            Company operations
  issue                              Issue operations
  agent                              Agent operations
  approval                           Approval operations
  activity                           Activity log operations
  dashboard                          Dashboard summary operations
  auth                               Authentication and bootstrap utilities
  help [command]                     display help for command

First-time local bootstrap + run:

```sh
pnpm paperclipai run
```
Mode             embedded-postgres  |  vite-dev-middleware
Deploy           local_trusted (private)
Auth             ready
Server           3100
API              http://127.0.0.1:3100/api (health: http://127.0.0.1:3100/api/health)
UI               http://127.0.0.1:3100
Database         /Users/ghu/.paperclip/instances/default/db (pg:54329)
Migrations       applied (pending migrations)
Agent JWT        set
Heartbeat        enabled (30000ms)
DB Backup        enabled (every 60m, keep 30d)
Backup Dir       /Users/ghu/.paperclip/instances/default/data/backups
Config           /Users/ghu/.paperclip/instances/default/config.json
  ───────────────────────────────────────────────────────

[13:30:07] INFO: Automatic database backups enabled
    intervalMinutes: 60
    retentionDays: 30
    backupDir: "/Users/ghu/.paperclip/instances/default/data/backups"
[13:30:07] INFO: Server listening on 127.0.0.1:3100

Choose local instance:

```sh
pnpm paperclipai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `paperclipai onboard` and `paperclipai configure --section server` set deployment mode in config
- runtime can override mode with `PAPERCLIP_DEPLOYMENT_MODE`
- `paperclipai run` and `paperclipai doctor` do not yet expose a direct `--mode` flag

Target behavior (planned) is documented in `doc/DEPLOYMENT-MODES.md` section 5.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.paperclip`:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- Deletion is server-gated by `PAPERCLIP_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `PAPERCLIP_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
```

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`

Example for shortname-based local setup:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## Approval Commands

```sh
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard Commands

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Default local instance root is `~/.paperclip/instances/default`:

- config: `~/.paperclip/instances/default/config.json`
- embedded db: `~/.paperclip/instances/default/db`
- logs: `~/.paperclip/instances/default/logs`
- storage: `~/.paperclip/instances/default/data/storage`
- secrets key: `~/.paperclip/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm paperclipai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)


  paperclip doctor 
│
│  ✓ Config file: Valid config at /Users/ghu/.paperclip/instances/default/config.json
│
│  ✓ Deployment/auth mode: local_trusted mode is configured for loopback-only access
│
│  ✓ Agent JWT secret: PAPERCLIP_AGENT_JWT_SECRET is set in environment
│
│  ✓ Secrets adapter: Local encrypted provider configured with key file /Users/ghu/.paperclip/instances/default/secrets/master.key
│
│  ✓ Storage: Local disk storage is writable: /Users/ghu/.paperclip/instances/default/data/storage
│
│  ✓ Database: Embedded PostgreSQL configured at /Users/ghu/.paperclip/instances/default/db (port 54329)
│
│  ✓ LLM provider: No LLM provider configured (optional)
│
│  ✓ Log directory: Log directory is writable: /Users/ghu/.paperclip/instances/default/logs
│
│  ✓ Server port: Port 3100 is available
│