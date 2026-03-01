---
name: Power Result Recording
description: How to record structured results when executing powers
trigger: power execution, power_result tool
---

# Power Result Recording

When executing a power, you MUST call the `power_result` tool at the end to persist your findings.

## Response Types

Choose the appropriate `response_type` based on what you produced:

- **text** — General markdown output (default)
- **report** — Structured analysis with sections, severity levels, and optional score. Include `title`, `summary`, and use markdown headings in `content` for sections. Include `score` (0-100) if applicable.
- **code** — Code output with code blocks. Use fenced code blocks with language tags in `content`.
- **pr** — GitHub PR references. Include PR URLs in `content` as markdown links.
- **table** — Tabular data. Use markdown tables in `content`.
- **links** — Collection of URLs. Use markdown links `[label](url)` in `content`.

## Example Usage

After completing a vulnerability scan:
```
power_result(
  power_id: "vulnerability-scan",
  power_name: "Vulnerability Scan",
  response_type: "report",
  title: "Security Audit Report",
  summary: "Found 3 vulnerabilities: 1 critical, 2 moderate",
  score: 65,
  content: "## Critical: SQL Injection in auth.ts\n..."
)
```

Always call this tool exactly once, at the very end of your power execution.
