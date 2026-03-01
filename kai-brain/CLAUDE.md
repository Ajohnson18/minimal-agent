# AVA Agent - Project Guidelines

## Documentation Canon (Read First)

This file is a fast reference. The authoritative, maintained architecture docs now live in `docs/`.

Start with:

1. `docs/README.md` - docs index and reading order
2. `docs/ARCHITECTURE.md` - system topology + lifecycle
3. `docs/MODULE_MAP.md` - file/module ownership
4. `docs/RUNTIME_FLOWS.md` - request and background execution paths
5. `docs/API_GATEWAY_CONTRACTS.md` - HTTP + WS contract surfaces
6. `docs/DATA_MODEL.md` - schema and persistence model
7. `docs/FEATURE_PLAYBOOK.md` - how to add features safely

When behavior changes, update those docs in the same PR.

## Architecture Overview

AVA is an AI agent service that:

- Runs on `pi-coding-agent` / `pi-agent-core` libraries
- Uses Google Vertex AI (Gemini) as the LLM provider
- Integrates with Slack for user interaction
- Executes Python code in Docker sandbox for data analysis
- Supports file uploads, scheduling, browser automation, and subagents

For current implementation details and module boundaries, prefer `docs/ARCHITECTURE.md` and `docs/MODULE_MAP.md` over this file snapshot.

## Google Vertex AI Tool Schema Compatibility

**CRITICAL**: Vertex AI has strict JSON Schema requirements. The following patterns will cause API errors:

### ❌ DO NOT USE

1. **`Type.Record()`** - Generates `patternProperties` which Vertex AI doesn't support

   ```typescript
   // BAD - will fail with "Unknown name patternProperties"
   Type.Record(Type.String(), Type.String())
   ```

2. **`Type.Unsafe` with complex enums** - Can cause issues with many enum values

   ```typescript
   // BAD - may cause "An unknown error occurred"
   Type.Unsafe<"a" | "b" | "c" | "d" | "e" | "f" | "g" | "h">({
     type: "string",
     enum: ["a", "b", "c", "d", "e", "f", "g", "h"],
   })
   ```

### ✅ USE INSTEAD

1. **`Type.Array()` with objects** for key-value pairs

   ```typescript
   // GOOD
   Type.Array(
     Type.Object({
       key: Type.String(),
       value: Type.String(),
     })
   )
   ```

2. **`Type.String()` with description** for enums with many values

   ```typescript
   // GOOD - describe valid values in description
   Type.String({
     description: 'Action: "status", "navigate", "click", "type", etc.',
   })
   ```

3. **Simple `Type.Unsafe`** for small enums (2-4 values) is usually fine

   ```typescript
   // OK for small enums
   Type.Unsafe<"up" | "down">({
     type: "string",
     enum: ["up", "down"],
   })
   ```

## Docker Sandbox (Python Execution)

### macOS File Sharing

Docker for Mac only shares certain directories by default:

- `/Users`
- `/Volumes`
- `/private`
- `/tmp` (symlink to `/private/tmp`)

**CRITICAL**: Do NOT use `tmpdir()` from Node.js on macOS - it returns `/var/folders/...` which Docker cannot access.

```typescript
// BAD - Docker can't access /var/folders/...
const workspaceDir = join(tmpdir(), "sandbox", id);

// GOOD - Use project directory (under /Users/)
const workspaceDir = join(process.cwd(), ".sandbox", id);
```

### Sandbox Image

Build with: `docker build -t ava-sandbox -f Dockerfile.sandbox .`

Pre-installed packages: pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, requests, beautifulsoup4, openpyxl, xlrd, pyyaml

## Tool Development Guidelines

### Creating Custom Tools

1. Place in `src/agent/tools/`
2. Export a `create<Name>Tool()` function
3. Register in `src/agent/pi-converter.ts` `createCustomTools()`
4. Keep schemas simple for Vertex AI compatibility

### Tool Schema Best Practices

```typescript
const MyToolSchema = Type.Object({
  // Required fields - use Type.String(), Type.Number(), Type.Boolean()
  name: Type.String({ description: "Clear description" }),
  
  // Optional fields - wrap with Type.Optional()
  option: Type.Optional(Type.Boolean({ description: "..." })),
  
  // Arrays of objects instead of Record
  items: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        value: Type.String(),
      })
    )
  ),
});
```

## File Structure

For the authoritative and actively maintained module ownership map, see `docs/MODULE_MAP.md`.

```
src/
├── agent/                  # Core agent logic
│   ├── executor-pi.ts           # Main agent executor (auto-compaction, model failover)
│   ├── pi-converter.ts          # Tool registration (bash filtered, 14 custom tools)
│   ├── system-prompt.ts         # System prompt builder (25+ conditional sections)
│   ├── subagent-executor.ts     # Subagent spawning (with model override)
│   ├── session-adapter.ts       # PostgreSQL session adapter
│   ├── context-pruning.ts       # Context management
│   ├── memory-extractor.ts      # Auto memory extraction per turn
│   └── tools/                   # Custom tools
│       ├── exec.tool.ts              # Shell execution (background/yield/PTY/env)
│       ├── process.tool.ts           # Background process mgmt (send-keys/submit/paste)
│       ├── process-registry.ts       # In-memory session tracking (buffer caps, sanitization)
│       ├── web-search.tool.ts        # Brave Search API (freshness/country/cache)
│       ├── web-fetch.tool.ts         # URL extraction (Readability/SSRF/cache)
│       ├── browser.tool.ts           # Playwright automation (pdf/dialog/upload/console)
│       ├── python.tool.ts            # Docker-sandboxed Python
│       ├── sql.tool.ts               # External PostgreSQL queries (read-only)
│       ├── memory.tool.ts            # Memory CRUD (search/save/list/delete)
│       ├── slack-actions.tool.ts     # Slack parity actions (send/read/edit/delete/react/pins/emojis/member info)
│       ├── slack-message.tool.ts    # Unified Slack messaging + file upload
│       ├── subagent.tool.ts          # Subagent spawning (timeout/model)
│       └── cron.tool.ts              # Scheduling tool
├── sandbox/                # Docker Python execution
│   ├── docker.ts                # Container management
│   └── executor.ts              # Python execution interface
├── services/               # Shared services
│   ├── media.service.ts         # Media pipeline (Gemini vision + Whisper fallback)
│   ├── memory.service.ts        # Hybrid search (vector + keyword)
│   ├── embedding.service.ts     # Multi-provider embeddings
│   └── auth.service.ts          # Google Cloud auth helper
├── gateway/                # WebSocket gateway for real-time
│   └── services/
│       ├── browser.ts           # Browser service (pdf/dialog/upload/console)
│       ├── cron.ts              # Cron service
│       └── queue-processor.ts   # Background job processor
├── handlers/               # Slack message handlers (slash commands, media processing)
├── api/                    # HTTP API routes
├── lib/                    # Shared utilities
│   ├── ssrf-guard.ts            # SSRF protection
│   ├── web-cache.ts             # TTL cache for web results
│   └── slack/                   # Slack utilities
├── skills/                 # Skill discovery and loading
├── hooks/                  # Event hooks system
└── scripts/                # Test scripts
    └── test-new-features.ts     # 44 tests, no Docker needed
```

## Common Issues & Solutions

### "An unknown error occurred" from Vertex AI

- Check tool schemas for `patternProperties` (from `Type.Record`)
- Check for complex enum types in `Type.Unsafe`
- Simplify tool parameters

### Python sandbox "No such file or directory"

- Verify Docker is running: `docker info`
- Check file path is under `/Users/` on macOS
- Ensure `.sandbox/` directory exists and is in `.gitignore`

### Slack file upload fails

- Verify session has valid `externalId` with format `slack:CHANNEL:THREAD_TS`
- Check Slack bot has `files:write` scope

## Environment Variables

Required in `.env`:

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
EXA_API_KEY=...                 # Web search (Exa)
OPENAI_API_KEY=sk-...           # Whisper audio fallback + OpenAI models
LLM_FALLBACK_MODEL=gemini-1.5-flash  # Model failover
AVA_WORKSPACE_DIR=~/.ava/workspace   # SOUL.md, USER.md, TOOLS.md
USER_TIMEZONE=America/New_York
EXEC_YIELD_MS=10000             # Auto-background timeout
```

## Testing

Canonical testing strategy and command matrix: `docs/TESTING.md`

```bash
# Type check
pnpm typecheck

# Run feature tests (44 tests, no Docker/DB needed)
npx tsx src/scripts/test-new-features.ts

# Run smoke tests (needs Docker + DB)
pnpm test:smoke

# Build sandbox image
docker build -t ava-sandbox -f Dockerfile.sandbox .

# Run locally
pnpm dev
```

## System Prompt Architecture

The system prompt uses 25+ conditional sections with 3 modes:
- `full` — main agent (all sections)
- `minimal` — subagents (safety + tooling only)
- `none` — single identity line

Key sections: Identity, Tooling, Tool Call Style, Safety, Skills, Memory Recall, Workspace, Subagent, Scheduling, Browser, Web Search, Python, Exec/Process, Slack Actions, Media, SQL, Timezone, Reply Tags, Heartbeat, Silent Replies, Reactions, Reasoning Format, Project Context, Runtime.

Context files (AGENTS.md, SOUL.md, USER.md, IDENTITY.md) from `AVA_WORKSPACE_DIR` are injected as `# Project Context`.
