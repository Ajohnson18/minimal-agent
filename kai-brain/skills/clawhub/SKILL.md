---
name: clawhub
description: Search, install, and update community skills from ClawHub (clawhub.com). Use when you need to find or install new skills on the fly.
metadata: { "gating": { "requires": { "bins": ["npm"] } } }
---

# ClawHub

Browse and install community skills from https://clawhub.com using the ClawHub CLI.

## Install the CLI (if needed)

```bash
npm i -g clawhub
```

Or use directly via npx:

```bash
npx clawhub@latest search "query"
```

## Search for Skills

```bash
clawhub search "postgres backups"
clawhub search "image generation"
```

## Install a Skill

Install into `~/.ava/skills/` so AVA picks it up:

```bash
clawhub install <skill-slug> --dir ~/.ava/skills
```

Or install to current workspace skills:

```bash
clawhub install <skill-slug>
```

## Update Skills

```bash
clawhub update <skill-name>
clawhub update --all
clawhub update --all --force
```

## List Installed Skills

```bash
clawhub list
```

## Notes

- Default registry: https://clawhub.com
- Skills follow the AgentSkills SKILL.md format (compatible with AVA, Claude Code, Codex)
- After installing, the skill is auto-discovered on AVA's next turn
- Override registry with `CLAWHUB_REGISTRY` env or `--registry` flag
- Override install directory with `--dir` or `CLAWHUB_WORKDIR` env
