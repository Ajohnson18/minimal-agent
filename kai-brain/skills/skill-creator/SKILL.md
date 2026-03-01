---
name: skill-creator
description: Create or update skills for AVA. Use when designing, structuring, or packaging new skills with scripts, references, and assets.
---

# Skill Creator

**IMPORTANT: Always create skills in `/mnt/kai-data/skills/`** — this is persistent storage. Do NOT use `/tmp/kai/skills/` (ephemeral, lost on restart). Skills are auto-reloaded on the next turn.

## Skill Structure

```
skill-name/
├── SKILL.md          (required — frontmatter + instructions)
├── scripts/          (optional — executable code)
├── references/       (optional — docs loaded into context as needed)
└── assets/           (optional — files used in output, not loaded into context)
```

## SKILL.md Format

```markdown
---
name: my-skill
description: Clear description of what this skill does and when to use it.
---

# Instructions here...
```

**Frontmatter rules:**

- `name` and `description` are required
- `description` is the primary trigger — include both what the skill does AND when to use it
- Optional `metadata` for gating:

```yaml
metadata: { "gating": { "requires": { "bins": ["gh"], "env": ["API_KEY"] } } }
```

Gating options:

- `bins`: all listed binaries must exist on PATH
- `anyBins`: at least one must exist on PATH
- `env`: all listed env vars must be set

## Writing Guidelines

1. **Be concise** — the context window is shared. Only add info the model doesn't already know.
2. **Use imperative form** — "Run X", "Create Y", not "You should run X"
3. **Prefer examples over explanations** — show, don't tell
4. **Progressive disclosure** — keep SKILL.md under 200 lines. Split details into `references/` files and reference them from SKILL.md.
5. **No extra docs** — don't create README.md, CHANGELOG.md, etc.

## When to Create Skills

- User asks you to create one
- You learn a reusable workflow worth preserving
- You research a topic and want to capture the knowledge
- A repetitive task would benefit from structured instructions

## Naming

- Lowercase, hyphens only: `my-skill-name`
- Short, action-oriented when possible
- Namespace by tool when helpful: `gh-pr-review`, `notion-sync`

## Creation Steps

1. Create the skill directory in persistent storage: `mkdir -p /mnt/kai-data/skills/my-skill`
2. Write SKILL.md with frontmatter + instructions
3. Optionally add `scripts/`, `references/`, `assets/` subdirectories
4. Register in the skill tree using the `skill_tree` tool with action `register`, passing the skill's `name` and `description` from the frontmatter
5. Skill is auto-discovered on next turn

## Updating Workspace Context

Beyond skills, you can also update workspace context files in `/mnt/kai-data/workspace/`:

- **SOUL.md** — persona, tone, behavioral preferences
- **TEAM.md** — team context, priorities, operating constraints
- **TOOLS.md** — tool notes, workflow patterns, integrations
