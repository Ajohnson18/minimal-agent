# AVA Sandbox Guide

Complete guide for secure Docker-based code execution in AVA.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration](#configuration)
3. [Testing](#testing)
4. [MCP Integration](#mcp-integration)
5. [Browser Tool Setup](#browser-tool-setup)
6. [Tool Compatibility](#tool-compatibility)
7. [Troubleshooting](#troubleshooting)
8. [Security](#security)

---

## Quick Start

### 1. Build Sandbox Image

```bash
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
```

This includes:
- Node.js 22
- Python 3 + data science stack (pandas, numpy, matplotlib, etc.)
- Essential CLI tools (git, curl, jq, ripgrep)
- mcporter for MCP server access

### 2. Enable Sandbox Mode

**Option A: Environment Variable**
```bash
export SANDBOX_MODE=all
export SANDBOX_NETWORK=bridge  # For MCP/web access
```

**Option B: Configuration File** (`config.json`)
```json
{
  "sandbox": {
    "mode": "all",
    "scope": "user",
    "network": "bridge",
    "workdir": "/workspace",
    "exec": {
      "security": "full"
    }
  }
}
```

### 3. Restart AVA

```bash
pnpm dev
```

### 4. Verify Setup

```bash
./scripts/test-sandbox.sh
```

---

## Configuration

### Sandbox Modes

- **`off`** (default) - Sandbox disabled, all tools run on host
- **`all`** - All users sandboxed (recommended)
- **`non-main`** - Only non-owner users sandboxed

Fail-closed policy:
- If sandbox is required (`all` / `non-main` for the current user) and unavailable, AVA returns `SANDBOX_UNAVAILABLE` and does not execute on host.

### Sandbox Scopes

- **`shared`** - One container for all sessions (lighter weight)
- **`session`** - Per-conversation container (isolated per thread)
- **`user`** - Per-user container (isolated per user)

### Network Modes

- **`none`** - Maximum isolation, no network access
- **`bridge`** - Standard Docker networking (required for MCP/browser/web)

### Security Modes

- **`full`** - Allow all commands (default)
- **`allowlist`** - Only allow specific commands
- **`deny`** - Block all exec commands

Example with allowlist:
```json
{
  "sandbox": {
    "exec": {
      "security": "allowlist",
      "allowlist": ["git", "npm", "node", "python3", "ls", "cat"]
    }
  }
}
```

---

## Testing

### Image Verification

Before running AVA with sandbox enabled, verify the image capabilities:

```bash
pnpm sandbox:verify-image
```

This checks:
- Docker connectivity
- Sandbox image availability
- Required binaries (`python3`, `node`, `git`, `rg`)
- Required Python packages (`requests`, `pandas`, `numpy`, `matplotlib`)

### Auth-Required Smoke

Run the full auth-compatible smoke suite:

```bash
pnpm test:docker:smoke
```

Smoke coverage includes:
- Authenticated HTTP + Gateway checks
- Browser sandbox RPC (`browser.status`, `browser.navigate`)
- Python sandbox execution via container-manager path

### Essential Tests

Copy-paste these into Slack to verify sandbox works:

#### 1. Basic File Operations
```
Write a file called hello.txt with content "Hello from sandbox" then read it back
```

Expected: File created at `/workspace/hello.txt` and content matches

#### 2. Directory Operations
```
Create directory data/logs/ and write a file data/logs/test.log with content "log entry"
```

Expected: Nested directories created successfully

#### 3. Python Execution
```
Run Python code to create a pandas DataFrame with 3 rows and save it as data.csv
```

Expected: CSV file created with data

#### 4. Git Operations
```
Run git init in workspace and create a .gitignore file
```

Expected: Git repository initialized

#### 5. Web Requests
```
Use Python requests to fetch https://api.github.com/zen and show the result
```

Expected: GitHub zen message displayed (requires `network: bridge`)

---

## MCP Integration

### What is MCP?

Model Context Protocol (MCP) allows AVA to access external tools like Linear, Notion, GitHub, etc.

### Setup

#### 1. Install mcporter on Host

```bash
npm install -g mcporter
```

#### 2. Configure MCP Servers

Import from existing config:
```bash
mcporter config import
```

Or manually create `~/.mcporter/config.json`:
```json
{
  "servers": {
    "linear": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-linear"],
      "env": {
        "LINEAR_API_KEY": "your-key-here"
      }
    }
  }
}
```

#### 3. Rebuild Sandbox Image

After modifying Dockerfile.sandbox-exec:
```bash
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
```

#### 4. Enable Network Access

```bash
export SANDBOX_NETWORK=bridge
```

MCP servers run on host and sandbox connects via bridge network.

### How It Works

```
Host:
  ├─ mcporter binary (globally installed)
  ├─ ~/.mcporter/config.json (server configs)
  └─ MCP servers running

Docker Container:
  ├─ mcporter binary (in image)
  ├─ ~/.mcporter/ (mounted read-only)
  └─ network: bridge → can reach host
```

The sandbox automatically mounts:
- `~/.mcporter/` → `/home/sandbox/.mcporter/` (read-only)
- `~/.mcp/` → `/home/sandbox/.mcp/` (read-only)

---

## Browser Tool Setup

### When AVA is Sandboxed

The browser tool requires special configuration to access Chrome.

#### 1. Start Browser Container

```bash
# Preferred: uses this repo's browser sandbox image + noVNC
pnpm browser:up

# Equivalent compose command
docker compose up browser-sandbox -d
```

#### 2. Configure AVA

In `config.json`:
```json
{
  "sandbox": {
    "mode": "all",
    "network": "bridge"  // Required
  },
  "tools": {
    "browser": {
      "mode": "sandbox",
      "cdpUrl": "http://host.docker.internal:9222"
    }
  }
}
```

**Key Point**: Use `host.docker.internal:9222` not `localhost:9222` when AVA runs in Docker.

#### 3. Optional: Increase Browser Size

The browser sandbox now defaults to a larger display (`1920x1080`), and size can be tuned via environment variables.

Set in `.env` (or compose env):

```bash
BROWSER_XVFB_WIDTH=1920
BROWSER_XVFB_HEIGHT=1080
BROWSER_WINDOW_WIDTH=1920
BROWSER_WINDOW_HEIGHT=1080
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080
```

Then restart the browser sandbox:

```bash
pnpm browser:up
```

---

## Tool Compatibility

### ✅ Fully Compatible

When sandbox is enabled, these tools work normally:

- **File Tools**: read, write, edit, grep, find, ls
- **exec**: Shell command execution
- **python_exec**: Python code (now uses sandbox container)
- **web_search**: Web searches (requires `network: bridge`)
- **web_fetch**: URL fetching (requires `network: bridge`)
- **memory**: Long-term memory storage
- **sql_query**: Database queries (if DB accessible)
- **slack_message**: Slack interactions
- **user_manage**: User management
- **schedule**: Cron jobs

### ⚠️ Requires Configuration

- **browser**: Needs `network: bridge` + correct CDP URL (see Browser Tool Setup)
- **MCP tools** (Linear, etc.): Needs `network: bridge` + mcporter (see MCP Integration)

### ❌ Not Compatible

None! All tools now work in sandbox mode.

---

## Troubleshooting

### Common Issues

#### 1. "Permission denied" errors

**Problem**: Workspace directory not writable

**Solution**:
```bash
# Check permissions
ls -la .sandbox/*/workspace

# Fix permissions (if needed)
chmod 755 .sandbox/*/workspace
```

#### 2. "Docker is not running"

**Problem**: Docker daemon not accessible

**Solution**:
```bash
# Check Docker status
docker info

# Start Docker Desktop (macOS/Windows)
# or start docker service (Linux)
sudo systemctl start docker
```

#### 3. Python packages missing

**Problem**: Package not installed in sandbox image

**Solution**: Add to `Dockerfile.sandbox-exec` and rebuild:
```dockerfile
RUN pip3 install --no-cache-dir --break-system-packages \
    your-package-name
```

Then rebuild:
```bash
docker build -t ava-sandbox-exec -f Dockerfile.sandbox-exec .
```

#### 4. MCP tools not working

**Problem**: Network access or mcporter not installed

**Solutions**:
- Verify `network: bridge` is set
- Check mcporter installed: `docker exec <container> which mcporter`
- Verify config mounted: `docker exec <container> ls -la /home/sandbox/.mcporter`

#### 5. Browser tool fails

**Problem**: CDP endpoint not reachable

**Solutions**:
- Verify browser container running: `docker ps | grep browser`
- Check network mode: `network: bridge` required
- Test CDP: `curl http://host.docker.internal:9222/json/version`
- Use correct URL: `host.docker.internal:9222` not `localhost:9222`

#### 6. Container keeps restarting

**Problem**: Container crashes on startup

**Solution**:
```bash
# Check container logs
docker logs <container-name>

# Inspect container
docker inspect <container-name>

# Test image directly
docker run --rm -it ava-sandbox-exec bash
```

### Diagnostic Script

Run comprehensive health check:
```bash
./scripts/test-sandbox.sh
```

This checks:
- Docker status
- Image existence
- Running containers
- Workspace directories
- Configuration
- Container security
- Network access

---

## Security

### Security Features

1. **Read-Only Root Filesystem**
   - Container root is read-only
   - Only `/workspace` is writable

2. **Dropped Capabilities**
   - All Linux capabilities dropped (`--cap-drop ALL`)
   - Prevents privilege escalation

3. **Non-Root User**
   - Runs as `sandbox` user (UID 1000)
   - No root access inside container

4. **Security Options**
   - `--security-opt no-new-privileges`
   - Prevents gaining additional privileges

5. **Resource Limits**
   - Memory: 512MB (configurable)
   - CPU: 1 core (configurable)

6. **Path Validation**
   - Blocks mounting dangerous paths:
     - `/var/run/docker.sock`
     - `/etc`, `/proc`, `/sys`, `/dev`
     - `/root`

### Best Practices

1. **Use `network: none` when possible**
   - Maximum isolation
   - Only use `bridge` when MCP/browser needed

2. **Keep image minimal**
   - Only install necessary packages
   - Reduces attack surface

3. **Regular updates**
   - Rebuild image monthly
   - Update base image: `node:22-slim`

4. **Monitor resource usage**
   ```bash
   docker stats $(docker ps --filter "name=ava-sandbox-" --format "{{.Names}}")
   ```

5. **Use allowlist for exec**
   ```json
   {
     "sandbox": {
       "exec": {
         "security": "allowlist",
         "allowlist": ["git", "npm", "node", "python3"]
       }
     }
   }
   ```

### Security Violation Examples

Attempts to mount dangerous paths are blocked:

```typescript
// ❌ Blocked automatically
docker run -v /var/run/docker.sock:/var/run/docker.sock ...
docker run -v /etc:/etc ...
docker run -v /root:/root ...

// Error message:
// Security violation: Cannot mount /var/run/docker.sock in sandbox mode.
// This would compromise container isolation.
```

---

## Advanced Configuration

### Multiple Sandbox Images

Create specialized images for different use cases:

```bash
# Data science focused
docker build -t ava-sandbox-datascience -f Dockerfile.sandbox-ds .

# Web scraping focused
docker build -t ava-sandbox-webscraping -f Dockerfile.sandbox-web .
```

Then specify in config:
```json
{
  "sandbox": {
    "image": "ava-sandbox-datascience"
  }
}
```

### Custom Workspace Location

```json
{
  "sandbox": {
    "scope": "user",
    "workdir": "/workspace"
  }
}
```

Workspaces stored in: `.sandbox/<user-id>-<scope>/workspace/`

### Container Lifecycle

- **Shared**: One container, persistent across sessions
- **Session**: Created per conversation, cleaned up after idle timeout
- **User**: One per user, persistent

Idle timeout (default 30 minutes):
```json
{
  "sandbox": {
    "idleTimeoutMs": 1800000
  }
}
```

---

## Files Reference

- **Image**: `Dockerfile.sandbox-exec`
- **Configuration**: `config.json` (sandbox section)
- **Container Manager**: `src/sandbox/container-manager.ts`
- **Python Tool**: `src/agent/tools/python.tool.ts`
- **Diagnostic Script**: `scripts/test-sandbox.sh`

---

## Support

For issues or questions:
1. Run diagnostic: `./scripts/test-sandbox.sh`
2. Check logs: `docker logs <container-name>`
3. Report issue with output from above

---

**Last Updated**: 2026-02-20
**AVA Version**: 0.1.0
