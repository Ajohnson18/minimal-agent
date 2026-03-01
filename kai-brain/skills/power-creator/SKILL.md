---
name: power-manager
description: Create, update, or delete Powers for KAI by writing POWER.md files. Use when the user asks to create a new power, edit an existing power, save a conversation as a power, or remove a power.
---

# Power Manager

Powers are automated workflows defined as POWER.md files. The file IS the power — the database only tracks metadata (enabled, locked, refinements).

## Creating a Power

1. Call `manage_power(action: "get_powers_dir")` to get the directory path
2. Write the POWER.md file using the `write` tool to `{powers_dir}/{power-id}/POWER.md`
3. Call `manage_power(action: "reload")` to pick up the new file

### POWER.md Format

```markdown
---
id: vulnerability-scan
name: Vulnerability Scan
description: Scan the codebase for security vulnerabilities and open fix PRs
icon: 🛡️
category: security
integrations: github
tools: exec, read, grep, web_search
output: report
steps:
  - Scan for vulnerability patterns
  - Check dependencies for CVEs
  - Open fix PRs
artifacts:
  - key: open-vulns
    label: Open Vulnerabilities
    type: table
  - key: fix-prs
    label: Fix PRs
    type: links
---

## Step 1: Scan for vulnerability patterns

Use grep to search the codebase for common vulnerability patterns...

## Step 2: Check dependencies for CVEs

Run `exec` to check package lockfiles against known CVE databases...

## Step 3: Open fix PRs

For each vulnerability found, create a fix and open a PR...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique kebab-case identifier |
| `name` | Yes | Human-readable name |
| `description` | Yes | What this power does (shown in UI) |
| `icon` | No | Emoji icon (default: ⚡) |
| `category` | No | `security`, `quality`, `ops`, `analysis`, or `general` |
| `integrations` | No | Comma-separated integration IDs (e.g. `github, slack`) |
| `skills` | No | Comma-separated skill IDs |
| `tools` | No | Comma-separated tool names |
| `output` | No | Expected output type |
| `steps` | No | YAML list of high-level steps |
| `artifacts` | No | Dashboard artifacts to pin (see below) |

### Writing a Good Prompt Body

The body after `---` is what the agent executes. This is the most important part:

1. **Use `## Step N:` headers** matching the `steps` list in frontmatter
2. **Be specific about tools** — name exactly which tools to use and how
3. **Include concrete examples** — show expected commands, output formats
4. **Handle edge cases** — what to do when steps fail or produce no results
5. **Use `{{variable}}` placeholders** for user-provided parameters
6. **Document environment** — which env vars are available, which hosts to use

### Declaring Artifacts

Artifacts are rich data pinned to the dashboard. When declared, the execution prompt automatically instructs the agent to call `pin_to_dashboard` for each one.

| type | Data shape | Use for |
|------|-----------|---------|
| `number` | `{value, unit?}` | Scalar metrics (counts, percentages) |
| `text` | `{content}` | Markdown summaries |
| `table` | `{columns, rows}` | Tabular data (vulnerability lists, leaderboards) |
| `image` | `{url, alt?}` | Charts, screenshots |
| `links` | `{items: [{url, label, description?}]}` | PR links, documentation references |
| `report` | `{summary, sections: [{heading, content, severity?}]}` | Structured reports with severity |

### Inferring Capabilities

Don't ask the user to manually pick tools/integrations. Infer them:

- Uses GitHub? → `integrations: github`, `tools: exec` (for git/gh CLI)
- Reads code? → `tools: read, grep, find`
- Runs commands? → `tools: exec`
- Searches web? → `tools: web_search, web_fetch`
- Writes files? → `tools: write, edit`

## Updating a Power

1. Read the existing POWER.md file
2. Modify the frontmatter and/or prompt body
3. Write the updated file back
4. Call `manage_power(action: "reload")`

## Deleting a Power

Call `manage_power(action: "delete", power_id: "the-id")` — this disables it in the database.

## Locking / Unlocking

Locked powers skip automatic prompt rewriting after runs:
- `manage_power(action: "lock", power_id: "the-id")`
- `manage_power(action: "unlock", power_id: "the-id")`

## From Conversation to Power

When the user asks to save a conversation as a power:

1. Analyze the conversation to identify the repeatable workflow
2. Generalize specific file paths, URLs, and names
3. Identify which tools and integrations were used
4. Determine the appropriate output type and artifacts
5. Write a thorough POWER.md with detailed step instructions
6. Call `manage_power(action: "reload")` to register it
