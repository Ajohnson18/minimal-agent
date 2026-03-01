#!/bin/bash
# Extract design context, tokens, and screenshot from a Figma URL

set -e

FIGMA_URL="$1"
OUTPUT_DIR="${2:-./.scratch/figma}"

if [ -z "$FIGMA_URL" ]; then
  echo "Usage: $0 <figma-url> [output-dir]"
  echo ""
  echo "Example:"
  echo "  $0 'https://www.figma.com/file/ABC123/MyFile?node-id=123:456' ./output"
  exit 1
fi

echo "🎨 Extracting design from Figma..."
echo "URL: $FIGMA_URL"
echo "Output: $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"

# Try remote server first, fall back to desktop
SERVER="figma"
if ! mcporter list --server "$SERVER" &>/dev/null; then
  echo "⚠️  Remote server (figma) unavailable, trying desktop server..."
  SERVER="figma-desktop"
fi

echo "📦 1/4 Getting design context..."
mcporter call "$SERVER.get_design_context" \
  url="$FIGMA_URL" \
  --output json > "$OUTPUT_DIR/design-context.json"

echo "🎨 2/4 Getting variables and tokens..."
mcporter call "$SERVER.get_variable_defs" \
  url="$FIGMA_URL" \
  --output json > "$OUTPUT_DIR/variables.json"

echo "📸 3/4 Getting screenshot..."
mcporter call "$SERVER.get_screenshot" \
  url="$FIGMA_URL" \
  --output json > "$OUTPUT_DIR/screenshot.json"

echo "🗂️  4/4 Getting metadata..."
mcporter call "$SERVER.get_metadata" \
  url="$FIGMA_URL" \
  --output json > "$OUTPUT_DIR/metadata.json"

echo ""
echo "✅ Done! Output saved to: $OUTPUT_DIR"
echo ""
echo "Files created:"
ls -lh "$OUTPUT_DIR"
