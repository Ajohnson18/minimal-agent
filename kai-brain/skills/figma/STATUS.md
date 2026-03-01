# Figma MCP Integration Status

## Current Status: ⚠️ Configured, Needs Desktop App to Test

### What's Working ✅
- MCP servers configured in mcporter
- Skill documentation created
- Helper scripts ready
- Integration code ready

### What's Blocked ❌
1. **Remote server** (`figma`) - Requires OAuth authentication (405 error)
2. **Desktop server** (`figma-desktop`) - Requires Figma Desktop app running

### How to Test

#### Option 1: Desktop Server (Recommended)
```bash
# 1. Download Figma Desktop app
# https://www.figma.com/downloads/

# 2. Open app and create/open a Design file

# 3. Enable MCP server:
#    - Switch to Dev Mode (Shift+D)
#    - In inspect panel, click "Enable desktop MCP server"

# 4. Verify server is running:
curl http://127.0.0.1:3845/mcp

# 5. List available tools:
mcporter list --server figma-desktop --schema

# 6. Test with a selection:
#    - Select a frame in Figma
#    - Run:
mcporter call figma-desktop.get_design_context

# 7. Or test with a URL:
mcporter call figma-desktop.get_design_context \
  url="https://www.figma.com/file/YOUR_FILE?node-id=123:456"
```

#### Option 2: Remote Server (Auth Issues)
The remote server requires OAuth which is currently failing with a 405 error. This may be an environment/network issue. Desktop server is more reliable.

### Quick Health Check
```bash
~/.ava/skills/figma/scripts/test-connection.sh
```

## Next Steps to Make It Fully Functional

1. **Install Figma Desktop app** (required for desktop server)
2. **Enable MCP server** in Dev Mode
3. **Test extraction** with the scripts

Once the desktop app is running, all features should work:
- ✅ Extract design context (React + Tailwind code)
- ✅ Get design tokens (colors, spacing, typography)
- ✅ Capture screenshots
- ✅ Get layer metadata
- ✅ Selection-based workflows (no URL needed)

## Documentation
- [SKILL.md](./SKILL.md) - Full documentation
- [README.md](./README.md) - Quick start
- [examples/generate-component.md](./examples/generate-component.md) - Example workflow
