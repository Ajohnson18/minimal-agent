/**
 * Browser Methods
 *
 * RPC handlers for browser control.
 */
import { browserService, type BrowserAction } from "../services/browser.js";
import { createError, ErrorCodes, type RpcError } from "../protocol/types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("gateway", { method: "browser" });

export interface BrowserStatusResult {
  running: boolean;
  url?: string;
  title?: string;
  tabCount: number;
}

export interface BrowserNavigateParams {
  url: string;
}

export interface BrowserNavigateResult {
  url: string;
  title: string;
}

export interface BrowserSnapshotParams {
  format?: "text" | "full";
}

export interface BrowserSnapshotResult {
  snapshot: string;
  refs: Record<string, { role: string; name?: string }>;
  url: string;
  title: string;
}

export interface BrowserActParams {
  action: BrowserAction;
}

export interface BrowserActResult {
  result: string;
}

export interface BrowserScreenshotParams {
  fullPage?: boolean;
}

export interface BrowserScreenshotResult {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface BrowserTabsParams {
  action?: "list" | "new" | "close" | "switch";
  tabId?: number;
  url?: string;
}

export interface BrowserTabsResult {
  tabs?: Array<{
    id: number;
    url: string;
    title: string;
    active: boolean;
  }>;
  tab?: {
    id: number;
    url: string;
    title: string;
    active: boolean;
  };
  success?: boolean;
}

export async function browserStatus(): Promise<BrowserStatusResult | RpcError> {
  try {
    return browserService.getStatus();
  } catch (error) {
    log.error({ err: error }, "Failed to get browser status");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      "Failed to get browser status"
    );
  }
}

export async function browserNavigate(
  params: BrowserNavigateParams
): Promise<BrowserNavigateResult | RpcError> {
  const { url } = params;

  if (!url) {
    return createError(ErrorCodes.INVALID_PARAMS, "url is required");
  }

  try {
    return await browserService.navigate(url);
  } catch (error) {
    log.error({ err: error, url }, "Failed to navigate");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to navigate: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function browserSnapshot(
  _params: BrowserSnapshotParams = {}
): Promise<BrowserSnapshotResult | RpcError> {
  try {
    return await browserService.snapshot();
  } catch (error) {
    log.error({ err: error }, "Failed to take snapshot");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to take snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function browserAct(
  params: BrowserActParams
): Promise<BrowserActResult | RpcError> {
  const { action } = params;

  if (!action || !action.type) {
    return createError(
      ErrorCodes.INVALID_PARAMS,
      "action with type is required"
    );
  }

  try {
    const result = await browserService.act(action);
    return { result };
  } catch (error) {
    log.error({ err: error, actionType: action.type }, "Failed to perform action");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to perform action: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function browserScreenshot(
  params: BrowserScreenshotParams = {}
): Promise<BrowserScreenshotResult | RpcError> {
  try {
    return await browserService.screenshot(params.fullPage);
  } catch (error) {
    log.error({ err: error, fullPage: params.fullPage ?? false }, "Failed to take screenshot");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to take screenshot: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function browserTabs(
  params: BrowserTabsParams = {}
): Promise<BrowserTabsResult | RpcError> {
  const { action = "list", tabId, url } = params;

  try {
    switch (action) {
      case "list": {
        const tabs = await browserService.getTabs();
        return { tabs };
      }

      case "new": {
        const tab = await browserService.newTab(url);
        return { tab };
      }

      case "close": {
        if (tabId === undefined) {
          return createError(
            ErrorCodes.INVALID_PARAMS,
            "tabId is required for close"
          );
        }
        const success = await browserService.closeTab(tabId);
        return { success };
      }

      case "switch": {
        if (tabId === undefined) {
          return createError(
            ErrorCodes.INVALID_PARAMS,
            "tabId is required for switch"
          );
        }
        const success = await browserService.switchTab(tabId);
        return { success };
      }

      default:
        return createError(
          ErrorCodes.INVALID_PARAMS,
          `Unknown action: ${action}`
        );
    }
  } catch (error) {
    log.error({ err: error, action, tabId }, "Failed to manage tabs");
    return createError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to manage tabs: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
