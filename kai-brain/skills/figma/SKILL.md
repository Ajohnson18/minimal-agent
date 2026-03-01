---
name: figma
description: Interact with Figma designs - extract design context, generate code from frames, get design tokens, and capture browser UIs to Figma.
metadata: { "gating": { "requires": { "bins": ["mcporter"] } } }
---

# Figma MCP Integration

Use the Figma MCP server to bring Figma designs into your code workflow.

## Overview

The Figma MCP server provides tools to:
- **Extract design context** from Figma files (layouts, components, variables)
- **Generate code** from Figma designs (React, Vue, SwiftUI, etc.)
- **Get design tokens** (colors, spacing, typography)
- **Map Figma to code** via Code Connect
- **Capture browser UIs** and convert to Figma frames

## Setup

Two servers available:
1. **Remote** (hosted): `figma` - requires Figma account auth
2. **Desktop** (local): `figma-desktop` - runs at `http://127.0.0.1:3845/mcp`

### Enable Desktop Server

1. Open Figma Desktop app (latest version)
2. Open any Figma Design file
3. Switch to Dev Mode (`Shift+D`)
4. In inspect panel, click "Enable desktop MCP server"
5. Server runs at `http://127.0.0.1:3845/mcp`

## Available Tools

### 1. get_design_context
Generate code from a Figma frame or selection.

```bash
# Using a Figma URL (works with both servers)
mcporter call figma.get_design_context \
  url="https://www.figma.com/file/ABC123/MyFile?node-id=123:456"

# Using desktop server with current selection
mcporter call figma-desktop.get_design_context
```

**Supported prompts:**
- "Generate this frame in Vue"
- "Generate in plain HTML + CSS"
- "Generate in iOS SwiftUI"
- "Use components from src/components/ui"

### 2. get_variable_defs
Extract design tokens (colors, spacing, typography, etc.)

```bash
mcporter call figma.get_variable_defs \
  url="https://www.figma.com/file/ABC123/MyFile?node-id=123:456"
```

### 3. get_code_connect_map
Get mapping between Figma nodes and code components.

```bash
mcporter call figma.get_code_connect_map \
  url="https://www.figma.com/file/ABC123/MyFile?node-id=123:456"
```

Returns: `{ nodeId: { codeConnectSrc: "path/to/component.tsx", codeConnectName: "Button" } }`

### 4. get_screenshot
Capture visual reference of a frame.

```bash
mcporter call figma.get_screenshot \
  url="https://www.figma.com/file/ABC123/MyFile?node-id=123:456"
```

### 5. get_metadata
Get layer structure as XML (for large designs).

```bash
mcporter call figma.get_metadata \
  url="https://www.figma.com/file/ABC123/MyFile?node-id=123:456"
```

Useful when `get_design_context` is too large - get the outline first, then fetch specific nodes.

### 6. create_design_system_rules
Generate a rule file for consistent code generation.

```bash
mcporter call figma.create_design_system_rules
```

Save output to `rules/` or `instructions/` directory for your IDE.

### 7. get_figjam (FigJam only)
Get metadata for FigJam diagrams with screenshots.

```bash
mcporter call figma.get_figjam \
  url="https://www.figma.com/file/ABC123/MyJam?node-id=123:456"
```

### 8. whoami (remote only)
Get authenticated user info.

```bash
mcporter call figma.whoami
```

## Usage Patterns

### Generate React Component from Figma

```bash
# 1. Get design context
mcporter call figma.get_design_context \
  url="https://www.figma.com/file/.../Button?node-id=123:456" \
  --output json > design.json

# 2. Get screenshot for reference
mcporter call figma.get_screenshot \
  url="https://www.figma.com/file/.../Button?node-id=123:456" \
  --output json > screenshot.json

# 3. Extract design tokens
mcporter call figma.get_variable_defs \
  url="https://www.figma.com/file/.../Button?node-id=123:456" \
  --output json > tokens.json
```

### Selection-Based Workflow (Desktop Only)

```bash
# 1. Select a frame in Figma Desktop app
# 2. Call without URL - uses current selection
mcporter call figma-desktop.get_design_context

# Works with all tools:
mcporter call figma-desktop.get_screenshot
mcporter call figma-desktop.get_variable_defs
mcporter call figma-desktop.get_metadata
```

### Capture Browser UI to Figma

**Note**: This feature requires a supported IDE with the Figma MCP plugin:
- VS Code with GitHub Copilot
- Cursor (install via `/plugin-add figma`)
- Claude Code (install via `claude plugin install figma@claude-plugins-official`)

The capture-to-clipboard feature is IDE-specific and not available via mcporter CLI.

## Best Practices

### Structure Figma Files for Better Code

- Use **components** for reusable elements
- Link components to code via **Code Connect**
- Use **variables** for spacing, color, radius, typography
- Name layers **semantically** (e.g., `CardContainer`, not `Group 5`)
- Use **Auto layout** for responsive intent

### Write Effective Prompts

```bash
# ✅ Good - specific framework and styling
"Generate iOS SwiftUI code from this frame"
"Use Chakra UI for this layout"
"Use src/components/ui components"

# ❌ Bad - vague
"Generate code"
```

### Break Down Large Selections

For big screens:
- Generate code for **smaller sections** (Card, Header, Sidebar)
- Use `get_metadata` first to get the structure
- Then fetch specific nodes with `get_design_context`

### Add Custom Rules

Create `.cursorrules`, `.clauderules`, or similar:

```markdown
## Figma MCP Integration Rules

1. Always run `get_design_context` first
2. If truncated, use `get_metadata` then re-fetch specific nodes
3. Run `get_screenshot` for visual reference
4. Download assets, then implement
5. Translate to project conventions (not raw Tailwind)
6. Reuse existing components
7. Use project tokens (colors, spacing, typography)
8. Validate against Figma for 1:1 parity
```

## Configuration

Current mcporter config:

```json
{
  "servers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    },
    "figma-desktop": {
      "type": "http",
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

## Troubleshooting

### Remote server auth error
The remote Figma MCP server requires OAuth authentication which may not work in all environments. Use `figma-desktop` instead.

### Desktop server offline
- Ensure Figma Desktop app is running
- Open a Design file
- Enable MCP server in Dev Mode
- Check server is running at `http://127.0.0.1:3845/mcp`

### Large designs timeout
- Use `get_metadata` first to get structure
- Fetch specific nodes instead of entire page
- Break selection into smaller components

## References

- [Figma MCP Guide](https://github.com/figma/mcp-server-guide)
- [Figma Blog: Claude Code to Figma](https://www.figma.com/blog/introducing-claude-code-to-figma/)
- [Figma Help: Setup Desktop MCP Server](https://help.figma.com/hc/en-us/articles/35281186390679)
