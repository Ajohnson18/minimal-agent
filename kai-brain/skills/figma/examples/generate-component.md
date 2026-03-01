# Example: Generate React Component from Figma

## Workflow

### 1. Get Figma URL
Right-click a frame in Figma → Copy link

Example: `https://www.figma.com/file/ABC123/DesignSystem?node-id=123:456`

### 2. Extract Design Context

```bash
# Get the React + Tailwind representation
mcporter call figma.get_design_context \
  url="https://www.figma.com/file/ABC123/DesignSystem?node-id=123:456" \
  > design-context.txt
```

This returns a React component with Tailwind classes that represents the design.

### 3. Get Design Tokens

```bash
# Extract variables (colors, spacing, typography)
mcporter call figma.get_variable_defs \
  url="https://www.figma.com/file/ABC123/DesignSystem?node-id=123:456" \
  --output json > tokens.json
```

### 4. Get Visual Reference

```bash
# Capture screenshot
mcporter call figma.get_screenshot \
  url="https://www.figma.com/file/ABC123/DesignSystem?node-id=123:456" \
  --output json > screenshot.json
```

### 5. Generate Final Code

Now you can:
1. Take the React + Tailwind code from step 2
2. Replace Tailwind classes with your project's design tokens from step 3
3. Reuse existing components where possible
4. Validate against the screenshot from step 4

### Using the Helper Script

Or use the all-in-one script:

```bash
./scripts/extract-design.sh \
  "https://www.figma.com/file/ABC123/DesignSystem?node-id=123:456" \
  ./output
```

This fetches all 4 artifacts at once:
- `design-context.json` - React + Tailwind code
- `variables.json` - Design tokens
- `screenshot.json` - Visual reference
- `metadata.json` - Layer structure

## Selection-Based (Desktop Only)

If using Figma Desktop app:

```bash
# 1. Open Figma Desktop
# 2. Enable MCP server in Dev Mode
# 3. Select the frame you want
# 4. Run:
mcporter call figma-desktop.get_design_context
```

No URL needed! It uses your current selection.

## Customizing Output

**Generate Vue instead of React:**
```bash
mcporter call figma.get_design_context \
  url="<figma-url>" \
  framework="vue"
```

**Get specific token types:**
```bash
mcporter call figma.get_variable_defs \
  url="<figma-url>" \
  types="color,spacing"
```

Check `mcporter call figma.get_design_context --help` for all options.
