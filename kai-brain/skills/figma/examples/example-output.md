# Example Output (When Working)

## What You'll See When It Works

### 1. get_design_context
**Command:**
```bash
mcporter call figma-desktop.get_design_context
```

**Output:** React + Tailwind code representing your Figma frame
```jsx
export default function CardComponent() {
  return (
    <div className="flex flex-col gap-4 p-6 bg-white rounded-lg shadow-md">
      <h2 className="text-2xl font-bold text-gray-900">Card Title</h2>
      <p className="text-base text-gray-600">
        This is a description that explains what this card is about.
      </p>
      <button className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
        Click Me
      </button>
    </div>
  );
}
```

### 2. get_variable_defs
**Command:**
```bash
mcporter call figma-desktop.get_variable_defs --output json
```

**Output:** Design tokens used in your selection
```json
{
  "colors": {
    "primary-500": "#3B82F6",
    "gray-900": "#111827",
    "gray-600": "#4B5563"
  },
  "spacing": {
    "spacing-4": "16px",
    "spacing-6": "24px"
  },
  "typography": {
    "text-2xl": "24px",
    "text-base": "16px"
  },
  "radius": {
    "rounded-lg": "8px",
    "rounded-md": "6px"
  }
}
```

### 3. get_screenshot
**Command:**
```bash
mcporter call figma-desktop.get_screenshot --output json
```

**Output:** Base64-encoded image or URL
```json
{
  "url": "http://localhost:3845/assets/89f254d1a998c9a6d1d324d43c73539c3993b16e.png",
  "width": 400,
  "height": 300,
  "format": "png"
}
```

### 4. get_metadata
**Command:**
```bash
mcporter call figma-desktop.get_metadata
```

**Output:** XML structure of layers
```xml
<node id="123:456" name="Card" type="FRAME">
  <node id="123:457" name="Title" type="TEXT">
    <property name="characters">Card Title</property>
    <property name="fontSize">24</property>
  </node>
  <node id="123:458" name="Description" type="TEXT">
    <property name="characters">This is a description...</property>
    <property name="fontSize">16</property>
  </node>
  <node id="123:459" name="Button" type="COMPONENT">
    <property name="width">120</property>
    <property name="height">40</property>
  </node>
</node>
```

## Complete Workflow Example

```bash
# Extract everything from a Figma URL
~/.ava/skills/figma/scripts/extract-design.sh \
  "https://www.figma.com/file/ABC/MyDesign?node-id=123:456" \
  ./my-component-output

# Output files created:
# my-component-output/
#   ├── design-context.json    # React + Tailwind code
#   ├── variables.json          # Design tokens
#   ├── screenshot.json         # Visual reference
#   └── metadata.json           # Layer structure
```

## Selection-Based (No URL Needed)

When using desktop server with a selection:
```bash
# 1. Select a frame in Figma Desktop app
# 2. Run without URL:
mcporter call figma-desktop.get_design_context

# It automatically uses your current selection!
```

## Error States

### Desktop Server Not Running
```bash
$ mcporter call figma-desktop.get_design_context
Error: Server unreachable at http://127.0.0.1:3845/mcp
→ Start Figma Desktop app and enable MCP server in Dev Mode
```

### Invalid URL
```bash
$ mcporter call figma.get_design_context url="invalid-url"
Error: Invalid Figma URL
→ Use format: https://www.figma.com/file/FILE_ID/NAME?node-id=NODE_ID
```

### Auth Required (Remote Server)
```bash
$ mcporter call figma.get_design_context url="..."
Error: Authorization required
→ Use desktop server (figma-desktop) instead, or run: mcporter auth figma
```
