# Heartbeat Checklist

This file contains your standing instructions for periodic heartbeat checks.

**What heartbeats are:** Every 30 minutes (by default), I check this list proactively without you asking. If something needs attention, I'll alert you. Otherwise, I'll suppress output.

**Guidelines:**

- Keep this list SHORT (3-5 items max)
- Focus on things that need REGULAR monitoring
- Don't add one-off tasks (those go in TODO.md)
- Be specific about what to check

---

## Default Checks

- Check for any running background processes or subagents
- If any processes/subagents completed, report the results
- Scan for any pending tasks that are blocked or need follow-up

---

## Custom Checks

<!-- Add your own monitoring items below -->

<!-- Example:
- Check if the production API at https://api.example.com/health returns 200
- Review error logs at /var/log/app/errors.log for new entries since last check
- If disk usage on server exceeds 85%, alert immediately
-->

---

## Output Protocol (Required)

Heartbeat runs must return exactly one JSON control envelope:

- Deliver alert:
`{"v":1,"action":"deliver","message":"<user-facing alert>"}`  
- All clear / no user-facing update:
`{"v":1,"action":"heartbeat_ack","reason":"all-clear"}`

Do not return plain text like `HEARTBEAT_OK`.
