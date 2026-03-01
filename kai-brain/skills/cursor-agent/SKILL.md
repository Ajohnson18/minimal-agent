---
name: cursor-agent
description: Manage Cursor Cloud Agents via API - launch agents, monitor status, send follow-ups, and cleanup. Use when working with Cursor's cloud-based AI coding agents.
metadata: { "gating": { "requires": { "env": ["CURSOR_API_KEY"] } } }
---

# Cursor Agent

Control Cursor Cloud Agents via the Cursor API. Requires `CURSOR_API_KEY` env var.

## Core Rule: Always Use a Subagent

**All Cursor API work MUST run inside `spawn_subagent`.** Never run Cursor launches, polling loops, or follow-ups as raw parent-level `exec`/`curl` calls.

Why:
- Cursor operations are long-running (polling loops block the parent session).
- Completion notifications only route through subagent announce.
- Parent stays responsive while the subagent handles the full lifecycle.

Use `mode: "run"` with `delivery.announce: "full"` (default) so the user gets notified on completion.
Use `delivery.announce: "silent"` only for internal prep where no user message is needed.

## Subagent Task Templates

### Launch & Monitor (most common)

```text
spawn_subagent(
  task="Launch a Cursor agent on <owner/repo> with prompt: '<goal>'. Poll status every 15s until terminal state (completed/failed/stopped). On completion, report: agent id, final state, and a summary of what the agent did (pull conversation if needed).",
  mode="run",
  delivery={announce:"full"}
)
```

For PR-based launches, replace `source` with `prUrl`:

```text
spawn_subagent(
  task="Launch a Cursor agent on PR <pr-url> with prompt: '<goal>'. Poll every 15s until terminal. Report agent id, final state, and outcome summary.",
  mode="run",
  delivery={announce:"full"}
)
```

### Follow-up on Running Agent

```text
spawn_subagent(
  task="Send follow-up to Cursor agent <agent-id>: '<instruction>'. Then poll until terminal state and report outcome.",
  mode="run",
  delivery={announce:"full"}
)
```

### Status Check (quick)

```text
spawn_subagent(
  task="Check status of Cursor agent <agent-id>. Report state, and if completed, pull the last few conversation messages for a summary.",
  mode="run",
  delivery={announce:"full"}
)
```

### List & Cleanup

```text
spawn_subagent(
  task="List all Cursor agents. Report id, state, and created time for each. Optionally stop/delete any agents in state <running/failed> older than <threshold>.",
  mode="run",
  delivery={announce:"full"}
)
```

## API Reference

Auth: Basic auth — `curl -u "$CURSOR_API_KEY:"` (key as username, no password).
Base URL: `https://api.cursor.com`

### Identity

```bash
curl -u "$CURSOR_API_KEY:" https://api.cursor.com/v0/me
```

### Launch Agent

From repository:

```bash
curl -u "$CURSOR_API_KEY:" \
  -X POST https://api.cursor.com/v0/agents \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": {"text": "<goal>"},
    "source": {"repository": "owner/repo"}
  }' | jq -r '.id'
```

From PR:

```bash
curl -u "$CURSOR_API_KEY:" \
  -X POST https://api.cursor.com/v0/agents \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": {"text": "<goal>"},
    "source": {"prUrl": "https://github.com/owner/repo/pull/123"}
  }' | jq -r '.id'
```

### Check Status

```bash
curl -u "$CURSOR_API_KEY:" \
  https://api.cursor.com/v0/agents/<agent-id> | jq '.state'
```

States: `pending` → `running` → `completed` / `failed` / `stopped`

### Poll Until Terminal

```bash
while true; do
  STATE=$(curl -s -u "$CURSOR_API_KEY:" \
    https://api.cursor.com/v0/agents/<agent-id> | jq -r '.state')
  echo "State: $STATE"
  [[ "$STATE" =~ ^(completed|failed|stopped)$ ]] && break
  sleep 15
done
```

### Follow-up

```bash
curl -u "$CURSOR_API_KEY:" \
  -X POST https://api.cursor.com/v0/agents/<agent-id>/followup \
  -H "Content-Type: application/json" \
  -d '{"text": "<instruction>"}' | jq '.'
```

### Conversation

```bash
curl -u "$CURSOR_API_KEY:" \
  https://api.cursor.com/v0/agents/<agent-id>/conversation | jq '.messages[-3:]'
```

### List Agents

```bash
curl -u "$CURSOR_API_KEY:" \
  https://api.cursor.com/v0/agents | jq '.agents[] | {id, state, created}'
```

### Stop / Delete

```bash
curl -u "$CURSOR_API_KEY:" -X POST https://api.cursor.com/v0/agents/<agent-id>/stop
curl -u "$CURSOR_API_KEY:" -X DELETE https://api.cursor.com/v0/agents/<agent-id>
```

### Models

```bash
curl -u "$CURSOR_API_KEY:" \
  https://api.cursor.com/v0/models | jq -r '.models[].name'
```

### Repositories (rate limited: 1/min, 30/hour)

```bash
curl -u "$CURSOR_API_KEY:" \
  https://api.cursor.com/v0/repositories | jq '.'
```

## Tracking Agents

For multi-session tracking, save agent IDs to memory:

```
memory(action: "save", key: "cursor-agent-auth-impl", content: "agent_id: abc123\ntask: User authentication\nstarted: 2024-01-15")
memory(action: "search", query: "cursor agent authentication")
```

## Error Handling

```bash
curl -u "$CURSOR_API_KEY:" ... | jq -r 'if .error then .error.message else . end'
```

## Troubleshooting

- **401 Unauthorized**: Verify `CURSOR_API_KEY` is set and not expired. Test with `/v0/me`.
- **429 Rate Limit**: Avoid polling `/repositories` (1/min limit). Use 15-30s intervals for agent status. Implement exponential backoff.
- **Follow-up fails**: Agent must be in `running` state (not `pending` or `completed`).
- **Empty conversation**: Agent may still be `pending`. Wait for `running` before pulling conversation.
