/**
 * Browser Tool
 *
 * Allows the agent to control a browser for web automation.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  browserService,
  type BrowserAction,
} from "../../gateway/services/browser.js";

// Simplified schema for Vertex AI compatibility
// Using Type.String for action instead of Type.Unsafe with enum
const BrowserActionSchema = Type.Object({
  action: Type.String({
    description:
      'Browser action: status, navigate, snapshot, content, click, type, fill, hover, scroll, press, wait, screenshot, tabs, pdf, dialog, console, upload.',
  }),

  // For navigate
  url: Type.Optional(
    Type.String({ description: "URL to navigate to (for navigate action)" })
  ),

  // For click, type, fill, hover
  ref: Type.Optional(
    Type.String({
      description:
        'Element reference from snapshot (e.g., "e1", "e2") for click/type/fill/hover',
    })
  ),

  // For type/fill
  text: Type.Optional(
    Type.String({ description: "Text to type or fill (for type/fill actions)" })
  ),

  // For type
  submit: Type.Optional(
    Type.Boolean({ description: "Press Enter after typing (for type action)" })
  ),

  // For scroll
  direction: Type.Optional(
    Type.String({
      description: 'Scroll direction: "up" or "down" (for scroll action)',
    })
  ),
  amount: Type.Optional(
    Type.Number({
      description: "Scroll amount in pixels (for scroll action, default 500)",
    })
  ),

  // For press
  key: Type.Optional(
    Type.String({
      description:
        'Key to press (e.g., "Enter", "Tab", "Escape") for press action',
    })
  ),

  // For wait
  ms: Type.Optional(
    Type.Number({ description: "Milliseconds to wait (for wait action)" })
  ),

  // For screenshot
  fullPage: Type.Optional(
    Type.Boolean({ description: "Capture full page (for screenshot action)" })
  ),

  // For dialog
  accept: Type.Optional(
    Type.Boolean({ description: "Accept or dismiss dialog (for dialog action)" })
  ),
  promptText: Type.Optional(
    Type.String({ description: "Text for prompt dialog (for dialog action)" })
  ),

  // For upload
  filePaths: Type.Optional(
    Type.Array(Type.String(), { description: "File paths to upload (for upload action)" })
  ),

  // For tabs
  tabAction: Type.Optional(
    Type.String({
      description: 'Tab action: "list", "new", "close", or "switch"',
    })
  ),
  tabId: Type.Optional(
    Type.Number({ description: "Tab ID for close/switch actions" })
  ),
});

type BrowserActionParams = Static<typeof BrowserActionSchema> & {
  action: string;
  direction?: string;
  tabAction?: string;
};

export function createBrowserTool(): ToolDefinition {
  return {
    name: "browser",
    label: "Browser",
    description: `Control a web browser for automation. Actions:
- status: Check if browser is running
- navigate: Go to a URL
- snapshot: Get page structure with element refs (e1, e2, etc.)
- click: Click an element by ref
- type: Type text into an element (use submit=true to press Enter)
- fill: Fill/replace text in an input
- hover: Hover over an element
- scroll: Scroll up or down
- press: Press a key (Enter, Tab, Escape, etc.)
- wait: Wait for specified milliseconds
- screenshot: Take a screenshot (saved to file)
- tabs: Manage browser tabs
- pdf: Save page as PDF
- dialog: Handle alert/confirm/prompt dialogs (accept=true/false)
- console: Get console messages
- upload: Set file input (ref + filePaths)

Workflow:
1. Use 'navigate' to go to a URL
2. Use 'snapshot' to see the page structure and get element refs
3. Use refs (e1, e2, etc.) to interact with elements via click/type/fill

Example: To search Google:
1. navigate: url="google.com"
2. snapshot: (see refs for search box and button)
3. type: ref="e1", text="search query", submit=true`,
    parameters: BrowserActionSchema,
    execute: async (
      _toolCallId: string,
      args: BrowserActionParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (_signal?.aborted) {
        return {
          content: [{ type: "text", text: "Browser action aborted" }],
          details: { aborted: true },
        };
      }

      try {
        const result = await executeBrowserAction(args);
        return {
          content: [{ type: "text", text: result }],
          details: { result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isServiceDown =
          message.includes("BROWSER_UNAVAILABLE") ||
          message.includes("Browser sandbox is unavailable") ||
          message.includes("Failed to connect to browser sandbox") ||
          message.includes("not running") ||
          message.includes("not connected") ||
          message.includes("ECONNREFUSED") ||
          message.includes("no browser");
        const guidance = isServiceDown
          ? `\n\nThe browser service is unavailable. Do NOT retry this action. Inform the user that browser automation is currently unavailable. Operator action: verify BROWSER_CDP_URL and start browser-sandbox (docker compose up browser-sandbox).`
          : "";
        return {
          content: [{ type: "text", text: `Error: ${message}${guidance}` }],
          details: { error: message, retryable: !isServiceDown },
        };
      }
    },
  };
}

async function executeBrowserAction(
  args: BrowserActionParams
): Promise<string> {
  switch (args.action) {
    case "status": {
      const status = browserService.getStatus();
      if (!status.running) {
        return "Browser is not running. Use navigate to start it.";
      }
      return `Browser running at ${status.url || "about:blank"} (${
        status.tabCount
      } tab(s))`;
    }

    case "navigate": {
      if (!args.url) {
        return "Error: url is required for navigate action. Ask the user for the URL instead of retrying.";
      }
      const result = await browserService.navigate(args.url);
      return `Navigated to: ${result.title} (${result.url})`;
    }

    case "snapshot": {
      const result = await browserService.snapshot();
      const refCount = Object.keys(result.refs).length;
      return `Page: ${result.title}\nURL: ${result.url}\n\nPage structure (${refCount} interactive elements):\n\n${result.snapshot}`;
    }

    case "content": {
      const result = await browserService.getContent();
      return `Page: ${result.title}\nURL: ${result.url}\n\nContent:\n${result.content}`;
    }

    case "click": {
      if (!args.ref) {
        return "Error: ref is required for click action. Use 'snapshot' first to get element refs.";
      }
      const action: BrowserAction = { type: "click", ref: args.ref };
      return await browserService.act(action);
    }

    case "type": {
      if (!args.ref || args.text === undefined) {
        return "Error: ref and text are required for type action. Use 'snapshot' first to get element refs.";
      }
      const action: BrowserAction = {
        type: "type",
        ref: args.ref,
        text: args.text,
        submit: args.submit,
      };
      return await browserService.act(action);
    }

    case "fill": {
      if (!args.ref || args.text === undefined) {
        return "Error: ref and text are required for fill action. Use 'snapshot' first to get element refs.";
      }
      const action: BrowserAction = {
        type: "fill",
        ref: args.ref,
        text: args.text,
      };
      return await browserService.act(action);
    }

    case "hover": {
      if (!args.ref) {
        return "Error: ref is required for hover action. Use 'snapshot' first to get element refs.";
      }
      const action: BrowserAction = { type: "hover", ref: args.ref };
      return await browserService.act(action);
    }

    case "scroll": {
      if (!args.direction) {
        return "Error: direction ('up' or 'down') is required for scroll action. Do not retry without specifying direction.";
      }
      const action: BrowserAction = {
        type: "scroll",
        direction: args.direction as "up" | "down",
        amount: args.amount,
      };
      return await browserService.act(action);
    }

    case "press": {
      if (!args.key) {
        return "Error: key is required for press action. Do not retry without specifying the key.";
      }
      const action: BrowserAction = { type: "press", key: args.key };
      return await browserService.act(action);
    }

    case "wait": {
      if (!args.ms) {
        return "Error: ms (milliseconds) is required for wait action. Do not retry without specifying duration.";
      }
      const action: BrowserAction = { type: "wait", ms: args.ms };
      return await browserService.act(action);
    }

    case "screenshot": {
      const result = await browserService.screenshotToFile(args.fullPage);
      return `Screenshot saved to ${result.path} (${result.width}x${result.height})`;
    }

    case "pdf": {
      const result = await browserService.savePdf();
      return `PDF saved to ${result.path} (${result.bytes} bytes)`;
    }

    case "dialog": {
      const result = await browserService.handleDialog(
        args.accept !== false,
        args.promptText
      );
      return result;
    }

    case "console": {
      const messages = await browserService.getConsoleMessages();
      return messages.join("\n") || "No console messages.";
    }

    case "upload": {
      if (!args.ref || !args.filePaths?.length) {
        return "Error: ref and filePaths are required for upload action. Use 'snapshot' first to get the file input ref.";
      }
      return await browserService.setFileInput(args.ref, args.filePaths);
    }

    case "tabs": {
      const tabAction = args.tabAction || "list";
      switch (tabAction) {
        case "list": {
          const tabs = await browserService.getTabs();
          if (tabs.length === 0) {
            return "No tabs open.";
          }
          const lines = tabs.map(
            (t) => `${t.active ? "> " : "  "}[${t.id}] ${t.title} (${t.url})`
          );
          return `Tabs:\n${lines.join("\n")}`;
        }
        case "new": {
          const tab = await browserService.newTab(args.url);
          return `Opened new tab [${tab.id}]: ${tab.url}`;
        }
        case "close": {
          if (args.tabId === undefined) {
            return "Error: tabId is required for close. Use tabs action with tabAction 'list' first to see available tab IDs.";
          }
          const success = await browserService.closeTab(args.tabId);
          return success
            ? `Closed tab ${args.tabId}`
            : `Tab ${args.tabId} not found`;
        }
        case "switch": {
          if (args.tabId === undefined) {
            return "Error: tabId is required for switch. Use tabs action with tabAction 'list' first to see available tab IDs.";
          }
          const success = await browserService.switchTab(args.tabId);
          return success
            ? `Switched to tab ${args.tabId}`
            : `Tab ${args.tabId} not found`;
        }
        default:
          return `Unknown tab action: ${tabAction}`;
      }
    }

    default:
      return `Unknown action: ${args.action}`;
  }
}
