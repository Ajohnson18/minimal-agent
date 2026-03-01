#!/bin/bash
# Test Figma MCP server connectivity

set -e

echo "🧪 Testing Figma MCP Integration"
echo "================================"
echo ""

# Test 1: Desktop Server
echo "📱 Test 1: Desktop Server (figma-desktop)"
echo "-------------------------------------------"
if curl -s --max-time 2 http://127.0.0.1:3845/mcp >/dev/null 2>&1; then
  echo "✅ Desktop server is running!"
  echo ""
  echo "Available tools:"
  mcporter list --server figma-desktop --schema 2>&1 | grep -A 100 "figma-desktop" || true
else
  echo "❌ Desktop server is offline"
  echo ""
  echo "To enable:"
  echo "  1. Open Figma Desktop app (download from figma.com/downloads)"
  echo "  2. Open any Design file"
  echo "  3. Switch to Dev Mode (Shift+D)"
  echo "  4. In inspect panel, click 'Enable desktop MCP server'"
  echo "  5. Re-run this test"
fi

echo ""
echo ""

# Test 2: Remote Server
echo "🌐 Test 2: Remote Server (figma)"
echo "-------------------------------------------"
if mcporter list --server figma 2>&1 | grep -q "auth required"; then
  echo "⚠️  Remote server requires authentication"
  echo ""
  echo "The remote server needs OAuth, which may not work in all environments."
  echo "Recommendation: Use the desktop server instead for now."
else
  echo "✅ Remote server is accessible!"
  mcporter list --server figma --schema 2>&1 | grep -A 100 "^figma" || true
fi

echo ""
echo ""

# Test 3: Try a public example (if desktop is running)
echo "🎨 Test 3: Quick Extraction Test"
echo "-------------------------------------------"
if curl -s --max-time 2 http://127.0.0.1:3845/mcp >/dev/null 2>&1; then
  echo "To test extraction:"
  echo ""
  echo "  1. Open Figma Desktop app"
  echo "  2. Open any file (or use a Community file)"
  echo "  3. Select a frame"
  echo "  4. Run:"
  echo "     mcporter call figma-desktop.get_design_context"
  echo ""
  echo "Or with a URL:"
  echo "  mcporter call figma-desktop.get_design_context \\"
  echo "    url='https://www.figma.com/file/YOUR_FILE?node-id=123:456'"
else
  echo "Desktop server not running - start it to test extraction"
fi

echo ""
echo "================================"
echo "✨ Test complete!"
