---
name: mcporter
description: Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.
metadata: { "gating": { "requires": { "bins": ["mcporter"] } } }
---

# mcporter

Use `mcporter` to work with MCP servers directly.

## Install

```bash
npm i -g mcporter
```

## Quick Start

```bash
mcporter list
mcporter list --schema
mcporter call <server.tool> key=value
```

## Call Tools

Selector syntax:
```bash
mcporter call linear.list_issues team=ENG limit:5
```

Function syntax:
```bash
mcporter call "linear.create_issue(title: \"Bug\")"
```

Full URL (ad-hoc HTTP server):
```bash
mcporter call https://api.example.com/mcp.fetch url:https://example.com
```

Stdio (ad-hoc local server):
```bash
mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com
```

JSON payload:
```bash
mcporter call <server.tool> --args '{"limit":5}'
```

## Auth + Config

```bash
mcporter auth <server> [--reset]
mcporter config list|get|add|remove|import|login|logout
```

Import configs from other tools:
```bash
mcporter config import          # auto-detect Cursor, Claude, VS Code, etc.
mcporter config import cursor
```

## Daemon

```bash
mcporter daemon start|status|stop|restart
```

## Codegen

```bash
mcporter generate-cli --server <name>
mcporter inspect-cli [--json]
mcporter emit-ts --mode client|types
```

## Notes

- Config default: `./config/mcporter.json` (override with `--config`)
- Prefer `--output json` for machine-readable results
- Supports both HTTP and stdio transports
- Can auto-import configs from Cursor, Claude, Windsurf, OpenCode, VS Code
