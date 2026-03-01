---
name: coding-agent
description: Run Codex CLI, Claude Code, or Pi Coding Agent as background sub-processes for programmatic control. Use when delegating coding tasks to other AI agents.
metadata: { "gating": { "requires": { "anyBins": ["claude", "codex", "pi"] } } }
---

# Coding Agent

Use exec + process tools to run coding agents as background sub-processes.

## PTY Required

Coding agents are interactive terminal apps. Always use `pty: true`:

```
exec(command: "codex exec 'Your prompt'", pty: true)
```

## Quick Start (One-Shot)

```
exec(command: "codex exec 'Add error handling to the API calls'", pty: true, workdir: "~/project")
```

For Codex, a git repo is required. For scratch work:
```
exec(command: "cd $(mktemp -d) && git init && codex exec 'Your prompt'", pty: true)
```

## Background Tasks

For longer work, use background mode:

```
exec(command: "codex exec --full-auto 'Build a REST API'", pty: true, background: true, workdir: "~/project")
# Returns sessionId

process(action: "log", sessionId: "xxx")     # Check output
process(action: "poll", sessionId: "xxx")     # Check if done
process(action: "submit", sessionId: "xxx", data: "yes")  # Send input + Enter
process(action: "kill", sessionId: "xxx")     # Kill if needed
```

## Agent Commands

**Codex CLI:**
- `codex exec "prompt"` — one-shot, exits when done
- `codex exec --full-auto "prompt"` — auto-approves in workspace
- `codex --yolo "prompt"` — no sandbox, no approvals (fastest)

**Claude Code:**
- `claude "prompt"` — interactive session

**Pi Coding Agent:**
- `pi "prompt"` — interactive
- `pi -p "prompt"` — non-interactive (pipe mode)
- `pi --provider openai --model gpt-4o-mini -p "prompt"` — custom model

## Parallel Work with Git Worktrees

```bash
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main
```

Then launch agents in each worktree via background exec.

## Rules

1. Always use `pty: true`
2. Respect the user's agent choice — don't silently switch
3. Be patient — don't kill sessions because they're "slow"
4. Monitor with `process(action: "log")` — check progress without interfering
5. Keep the user updated on progress for background tasks
