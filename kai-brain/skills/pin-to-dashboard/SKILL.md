---
name: Dashboard Artifact Management
description: Pin, update, remove, or list rich dashboard artifacts (numbers, tables, charts, images, links, reports) using the pin_to_dashboard tool
trigger: dashboard, pin_to_dashboard tool, track metric, power metric, dashboard artifact, pin artifact, remove metric, delete metric, chart, graph
---

# Dashboard Artifact Management

Use the `pin_to_dashboard` tool to manage dashboard artifacts. Artifacts appear as persistent cards on the Command Center.

## Actions

### pin (default)
Create or update an artifact. Same `power_id + key` = upsert.

```
pin_to_dashboard(
  power_id: "vulnerability-scan",
  power_name: "Vulnerability Scan",
  key: "open_vulns",
  label: "Open Vulnerabilities",
  artifact_type: "table",
  data: "{\"columns\":[\"Issue\",\"Severity\"],\"rows\":[[\"SQL Injection\",\"Critical\"]]}",
  icon: "🛡️"
)
```

### remove
Delete an artifact by `power_id + key`.

```
pin_to_dashboard(
  action: "remove",
  power_id: "vulnerability-scan",
  key: "open_vulns"
)
```

### list
Show all artifacts for a power.

```
pin_to_dashboard(
  action: "list",
  power_id: "vulnerability-scan"
)
```

## Artifact Types & Data Schemas

### number
```json
{ "value": "42", "unit": "users" }
```

### text
```json
{ "content": "## Summary\nEverything is healthy." }
```

### table
```json
{ "columns": ["Vulnerability", "Severity", "Fix PR"], "rows": [["SQL Injection", "Critical", "#42"]] }
```

### chart
Renders interactive charts. Supported `chartType` values: `bar`, `line`, `area`, `pie`, `stacked-bar`.

Multi-series via the `series` array — each series has a `name`, `values` array (same length as `labels`), and optional `color`.

**Bar chart:**
```json
{ "chartType": "bar", "labels": ["Mon", "Tue", "Wed", "Thu", "Fri"], "series": [{ "name": "Commits", "values": [12, 19, 8, 15, 22] }] }
```

**Line chart (multi-series):**
```json
{ "chartType": "line", "labels": ["Jan", "Feb", "Mar", "Apr"], "series": [{ "name": "PRs Opened", "values": [10, 14, 8, 12], "color": "#3b82f6" }, { "name": "PRs Merged", "values": [8, 12, 7, 11], "color": "#10b981" }] }
```

**Area chart:**
```json
{ "chartType": "area", "labels": ["Week 1", "Week 2", "Week 3", "Week 4"], "series": [{ "name": "Deploy Frequency", "values": [3, 5, 4, 7] }] }
```

**Pie chart:**
```json
{ "chartType": "pie", "labels": ["Critical", "High", "Medium", "Low"], "series": [{ "name": "Count", "values": [2, 5, 12, 8] }] }
```

**Stacked bar chart:**
```json
{ "chartType": "stacked-bar", "labels": ["Sprint 1", "Sprint 2", "Sprint 3"], "series": [{ "name": "Bugs", "values": [3, 2, 1] }, { "name": "Features", "values": [5, 7, 8] }] }
```

### image
```json
{ "url": "https://example.com/chart.png", "alt": "Weekly trend" }
```

### links
```json
{ "items": [{ "url": "https://github.com/org/repo/pull/42", "label": "Fix SQL Injection", "description": "Parameterizes auth queries" }] }
```

### report
```json
{ "summary": "Found 3 vulnerabilities", "sections": [{ "heading": "SQL Injection", "content": "Details...", "severity": "critical" }] }
```

## Notes

- Each unique `(power_id, key)` is a separate card
- Calling pin with an existing key updates it in place
- You can pin multiple artifacts per power execution
- Charts scale to card size — resize the card on the dashboard for bigger graphs
