# AVA Deployment Guide

## Prerequisites

- Ubuntu EC2 instance (tested on Amazon Linux 2023 / Ubuntu 22.04+)
- Node.js >= 22
- pnpm
- PostgreSQL with pgvector extension (RDS or self-hosted)
- Docker (required for sandbox mode, optional otherwise)

## Initial Setup

### 1. Clone and install

```bash
git clone <repo-url> /opt/ava
cd /opt/ava
pnpm install
pnpm build
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in required values:

```bash
cp .env.example .env
```

Required env vars:

```
DATABASE_URL=postgresql://user:pass@host:5432/ava
VERTEX_AI_PROJECT_ID=your-gcp-project
JWT_SECRET=<random-64-char-string>
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
```

Optional auth control env vars:

```
AVA_AUTH_REQUIRED=1              # default true
AVA_WS_ALLOW_QUERY_TOKEN=1       # allow ?token= for browser WS clients
AVA_AUTH_ISSUER=                 # optional strict issuer match
AVA_AUTH_AUDIENCE=               # optional strict audience match
```

Optional env vars for user system:

```
AVA_OWNER_SLACK_ID=U_YOUR_ID        # First user becomes owner anyway, but this is explicit
CREDENTIAL_ENCRYPTION_KEY=<64-char-hex>  # Falls back to JWT_SECRET if not set
```

### 3. Push database schema

```bash
pnpm db:push
```

When prompted about new tables (`ava_users`, `ava_user_identities`), select **"create table"** -- not rename.

### 3.1 Auth config (optional)

You can explicitly configure API/WS auth in `config.json`:

```json
{
  "server": {
    "auth": {
      "required": true,
      "wsAllowQueryToken": true,
      "issuer": "",
      "audience": ""
    }
  }
}
```

### 4. Start the service

```bash
pnpm start
# or with pm2:
pm2 start dist/index.js --name ava
# or with systemd (see below)
```

## Systemd Service

Create `/etc/systemd/system/ava-agent.service`:

```ini
[Unit]
Description=AVA Agent
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ava
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/ava/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ava-agent
sudo journalctl -u ava-agent -f  # tail logs
```

## Updating

```bash
cd /opt/ava
git pull
pnpm install
pnpm build
pnpm db:push          # apply any schema changes
sudo systemctl restart ava-agent
```

## Sandbox Mode (Docker Exec Isolation)

Sandbox mode runs exec commands inside Docker containers instead of directly on the host. This provides per-user isolation, read-only rootfs, memory/CPU limits, and network isolation.

### Setup

```bash
# Install Docker
sudo yum install docker -y          # Amazon Linux
# or: sudo apt install docker.io -y  # Ubuntu
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu      # allow non-root docker access
newgrp docker                       # apply group change

# Build the sandbox image
cd /opt/ava
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
```

### Enable

Add to `config.json`:

```json
{
  "sandbox": {
    "mode": "non-main",
    "scope": "user"
  }
}
```

Modes:
- `"off"` (default) -- no sandboxing, exec runs on host
- `"non-main"` -- sandbox all users except the owner
- `"all"` -- sandbox everyone including the owner

Fail-closed behavior:
- If sandbox is required and sandbox container provisioning fails, AVA does not fall back to host execution.
- HTTP `/api/ava/chat` returns `503` with machine code `SANDBOX_UNAVAILABLE`.
- Gateway `agent.run` returns deterministic `SANDBOX_UNAVAILABLE` RPC errors.
- Queue jobs fail with `SANDBOX_UNAVAILABLE` and do not enter retry loops.

Scopes:
- `"user"` (default) -- one container per user (reused across sessions)
- `"session"` -- one container per chat session
- `"shared"` -- single shared container for all sandboxed users

Or via env vars:

```bash
SANDBOX_MODE=non-main
SANDBOX_SCOPE=user
```

Preflight check before enabling sandbox mode:

```bash
pnpm sandbox:verify-image
```

### Exec Allowlisting

Restrict which commands can be run:

```json
{
  "sandbox": {
    "mode": "all",
    "exec": {
      "security": "allowlist",
      "allowlist": ["git *", "npm *", "node *", "mcporter *", "ls", "cat", "echo"]
    }
  }
}
```

Security modes:
- `"full"` (default) -- allow everything
- `"allowlist"` -- only commands matching the allowlist patterns
- `"deny"` -- block all exec calls

### Container Management

Containers are persistent (`sleep infinity`) and reused. They auto-prune after `idleTimeoutMs` (default: 30min). Manual cleanup:

```bash
# List sandbox containers
docker ps --filter name=ava-sandbox-

# Remove all sandbox containers
docker rm -f $(docker ps -q --filter name=ava-sandbox-)
```

### Phased Rollout

1. Stage validation: set `SANDBOX_MODE=non-main` and require 3 consecutive green runs.
2. Production phase 1: deploy with `SANDBOX_MODE=non-main` and monitor for 7 days (`SANDBOX_UNAVAILABLE`, queue sandbox failures, browser CDP failures).
3. Production phase 2: promote to `SANDBOX_MODE=all` only after zero critical incidents in phase 1.

Rollback:
- Immediately toggle `SANDBOX_MODE=off` if sandbox failures become user-impacting.
- Keep auth-required runtime (`AVA_AUTH_REQUIRED=1`) enabled during rollback.
- Use `docs/SANDBOX_PROD_CHECKLIST.md` before reattempting promotion.

## User System

Users are created automatically on first Slack interaction. The first user (or `AVA_OWNER_SLACK_ID`) becomes the owner.

### Roles

- **owner** -- full access, can manage other users via `/users` and `/role` slash commands
- **admin** -- elevated access, granted by owner
- **member** -- standard access

Role enforcement is off by default (`users.enforceRoles: false`). When enabled, per-user `toolPolicy` controls which tools each user can access.

### Credentials

Users store credentials conversationally ("here's my GitHub token: ghp_xxx"). Credentials are encrypted with AES-256-GCM and stored in the `ava_users` table. They're automatically injected as environment variables in exec calls.

### Slash Commands

- `/users` -- list all users (owner/admin only)
- `/role @user admin|member` -- change roles (owner only)
- `/help` -- show all commands

## Health Check

```bash
curl http://localhost:3001/api/ava/health
```

## Logs

```bash
# Systemd
sudo journalctl -u ava-agent -f --no-pager

# PM2
pm2 logs ava
```
