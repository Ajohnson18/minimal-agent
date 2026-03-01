# Figma MCP Integration

Interact with Figma designs via the Model Context Protocol.

## Quick Start

### Using Remote Server (requires auth)
```bash
mcporter call figma.get_design_context url="<figma-url>"
```

### Using Desktop Server (no auth, requires Figma app)
```bash
# 1. Open Figma Desktop app
# 2. Switch to Dev Mode (Shift+D)
# 3. Enable MCP server in inspect panel
# 4. Select a frame
# 5. Call without URL:
mcporter call figma-desktop.get_design_context
```

## Common Workflows

### Extract Design Tokens
```bash
mcporter call figma.get_variable_defs url="<figma-url>" --output json
```

### Generate Code
```bash
mcporter call figma.get_design_context url="<figma-url>"
```

### Get Layer Structure
```bash
mcporter call figma.get_metadata url="<figma-url>" --output json
```

## Documentation

See [SKILL.md](./SKILL.md) for full documentation.
