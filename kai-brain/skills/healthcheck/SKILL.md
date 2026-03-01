---
name: healthcheck
description: Host security hardening and system audit. Use when asked for security audits, firewall/SSH hardening, risk posture review, or system health checks.
---

# Host Healthcheck & Hardening

Assess and harden the host system. Requires explicit approval before any state-changing action.

## Core Rules

- Require explicit approval before any state-changing action
- Do not modify remote access settings without confirming how the user connects
- Prefer reversible, staged changes with a rollback plan
- If unsure about the environment, ask first

## Workflow

### 1. Establish Context (read-only)

Infer from the environment before asking. Run these checks (ask permission first):

```bash
# OS info
uname -a
sw_vers  # macOS

# Listening ports
lsof -nP -iTCP -sTCP:LISTEN  # macOS
ss -ltnp                       # Linux

# Firewall
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate  # macOS
ufw status          # Linux (Ubuntu)
firewall-cmd --state # Linux (RHEL/Fedora)

# Disk encryption
fdesetup status     # macOS (FileVault)

# Backups
tmutil status       # macOS (Time Machine)
```

Determine:
1. OS and version
2. Privilege level (root/admin vs user)
3. Access path (local, SSH, tailnet)
4. Network exposure (public IP, reverse proxy, tunnel)
5. Disk encryption status
6. Backup status
7. Auto-update status

### 2. Determine Risk Tolerance

Ask the user to pick a posture:

1. **Home/Workstation Balanced** — firewall on, remote access restricted to LAN/tailnet
2. **VPS Hardened** — deny-by-default firewall, key-only SSH, no root login, auto security updates
3. **Developer Convenience** — more local services allowed, explicit exposure warnings
4. **Custom** — user-defined constraints

### 3. Produce Remediation Plan

Include:
- Current posture summary
- Gaps vs target profile
- Step-by-step commands with rollback
- Access-preservation strategy
- Risks and lockout scenarios

Always show the plan before any changes.

### 4. Execute with Confirmations

For each step:
- Show the exact command
- Explain impact and rollback
- Confirm access will remain available
- Stop on unexpected output

### 5. Verify

Re-check after changes:
- Firewall status
- Listening ports
- Remote access still works

## Required Confirmations

Always require explicit approval for:
- Firewall rule changes
- Opening/closing ports
- SSH/RDP config changes
- Installing/removing packages
- Enabling/disabling services
- User/group modifications
- Update policy changes
