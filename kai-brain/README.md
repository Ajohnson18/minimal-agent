# AVA Agent

AI agent that runs on [pi-coding-agent](https://github.com/nicepkg/pi-coding-agent) / [pi-agent-core](https://github.com/nicepkg/pi-agent-core), integrates with Slack, and uses Google Vertex AI (Claude) as the LLM provider.

## Features

- **Slack Integration** — Interactive conversations, file uploads, media processing
- **Full Tool Suite** — Shell execution, web search, browser automation, Python sandbox, SQL queries, memory, TTS
- **Subagent System** — Spawn isolated subagents with full tool access, announce flow for result delivery
- **Channel-Agnostic Delivery** — Slack today, extensible for Telegram/Discord/etc via `delivery.ts`
- **Memory System** — Hybrid vector + keyword search for long-term memory persistence
- **Heartbeat System** — Periodic health checks with rotating cadence, silent suppression when nothing needs attention
- **Scheduling** — Cron jobs, one-time reminders, recurring tasks
- **Browser Automation** — Playwright in Docker with PDF, dialog, upload support
- **Python Sandbox** — Docker-sandboxed Python execution with pre-installed data science packages
- **Skills System** — Extensible skill discovery and loading from `~/.ava/skills/`
- **Context Management** — Auto-compaction, pruning, and model failover

## Documentation

Detailed codebase docs for humans and AI agents live in [`docs/README.md`](./docs/README.md).

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Set up database + Docker services
pnpm setup

# Build sandbox image
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
pnpm sandbox:verify-image

# Start development server
pnpm dev
```

## Architecture

```
src/
├── agent/                      # Core agent logic
│   ├── executor-pi.ts          # Main agent executor (compaction, model failover)
│   ├── pi-converter.ts         # Tool registration & schema conversion
│   ├── pi-provider.ts          # Model provider routing (Vertex AI, OpenAI, etc.)
│   ├── system-prompt.ts        # System prompt builder (25+ conditional sections)
│   ├── subagent-executor.ts    # Subagent spawning with full parent toolset
│   ├── subagent-announce.ts    # Result injection into parent → reformulation → delivery
│   ├── subagent-registry.store.ts  # Disk persistence for subagent runs
│   ├── delivery.ts             # Channel-agnostic response routing
│   ├── session-adapter.ts      # PostgreSQL session adapter
│   ├── context-pruning.ts      # Context management
│   ├── memory-extractor.ts     # Auto memory extraction per turn
│   └── tools/                  # Custom tools (20+)
│       ├── exec.tool.ts        # Shell execution (background/yield/PTY/env)
│       ├── process.tool.ts     # Background process management
│       ├── web-search.tool.ts  # Web search (Exa API, freshness/country/cache)
│       ├── web-fetch.tool.ts   # URL content extraction (Readability/SSRF/cache)
│       ├── browser.tool.ts     # Playwright automation
│       ├── python.tool.ts      # Docker-sandboxed Python
│       ├── sql.tool.ts         # External PostgreSQL queries (read-only)
│       ├── memory.tool.ts      # Memory CRUD (search/save/list/delete)
│       ├── slack-actions.tool.ts   # Slack reactions, pins, member info
│       ├── slack-message.tool.ts   # Unified Slack messaging + file upload
│       ├── subagent.tool.ts    # Subagent spawning with announce flow
│       ├── subagent-registry.ts    # Run tracking with persistence + announce trigger
│       └── cron.tool.ts        # Scheduling (cron/at/every)
├── slack/monitor/              # Active Slack ingress/monitor pipeline
├── handlers/                   # Legacy Slack compatibility exports
├── gateway/                    # WebSocket gateway + background services
│   └── services/
│       ├── browser.ts          # Browser service (Playwright lifecycle)
│       ├── cron.ts             # Cron scheduler
│       └── queue-processor.ts  # Background job processor (HEARTBEAT_OK suppression)
├── services/                   # Shared services
│   ├── media.service.ts        # Media pipeline (Gemini vision + Whisper fallback)
│   ├── memory.service.ts       # Hybrid search (vector + keyword)
│   └── embedding.service.ts    # Multi-provider embeddings
├── db/                         # Database (Drizzle ORM + PostgreSQL)
├── lib/                        # Shared utilities (SSRF guard, web cache, Slack helpers)
├── skills/                     # Skill discovery and loading
└── hooks/                      # Event hooks system
```

## Subagent Architecture

Subagents get the full parent toolset (exec, web_search, browser, python, memory, etc.) and run in isolation. Results are delivered via an announce flow:

```
1. Parent spawns subagent → returns immediately
2. Subagent runs in background with full tool access
3. On completion → registry triggers announce flow
4. Announce injects result into parent agent session
5. Parent reformulates in its own voice
6. delivery.ts routes response to channel (Slack/Telegram/etc.)
```

## Heartbeat System

Periodic background check-ins via cron. Reads `HEARTBEAT.md` and runs rotating health checks:

```
Every 2h → Read HEARTBEAT.md → Run most overdue check
  Nothing wrong? → HEARTBEAT_OK (silently suppressed)
  Something off? → Alert delivered to Slack
```

## Environment Variables

Required:

```
GOOGLE_CLOUD_PROJECT=your-project
GOOGLE_CLOUD_LOCATION=us-central1
VERTEX_AI_CREDENTIALS={"type":"service_account",...}
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
DATABASE_URL=postgresql://...
```

Optional:

```
EXA_API_KEY=...                     # Web search
OPENAI_API_KEY=sk-...               # Whisper audio fallback + OpenAI models
LLM_FALLBACK_MODEL=gemini-1.5-flash # Model failover
AVA_WORKSPACE_DIR=~/.ava            # SOUL.md, USER.md, HEARTBEAT.md
USER_TIMEZONE=America/New_York
EXEC_YIELD_MS=10000                 # Auto-background timeout for exec
SLACK_REQUIRE_MENTION=true          # Default room policy: require mention unless channel override allows otherwise
BROWSER_XVFB_WIDTH=1920             # Sandbox virtual display width
BROWSER_XVFB_HEIGHT=1080            # Sandbox virtual display height
BROWSER_WINDOW_WIDTH=1920           # Chromium window width in sandbox
BROWSER_WINDOW_HEIGHT=1080          # Chromium window height in sandbox
BROWSER_VIEWPORT_WIDTH=1920         # Playwright viewport width
BROWSER_VIEWPORT_HEIGHT=1080        # Playwright viewport height
```

## Development

```bash
pnpm dev              # Dev mode with hot reload
pnpm typecheck        # Type check
pnpm lint             # Lint
pnpm test             # Run tests
pnpm test:smoke       # Smoke tests (needs Docker + DB)
pnpm build            # Build for production
pnpm start            # Start production

# Browser sandbox
pnpm browser:up       # Start Playwright container
pnpm browser:down     # Stop it
pnpm browser:vnc      # Open VNC viewer

# Database
pnpm db:generate      # Generate migration from schema
pnpm db:push          # Apply migrations
pnpm db:studio        # Open Drizzle Studio
```

## License

Proprietary — Copyright (c) 2026 Arman Khan. See [LICENSE](./LICENSE) for details.
