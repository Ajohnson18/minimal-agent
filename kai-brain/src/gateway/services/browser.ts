/**
 * Browser Service
 *
 * Manages browser automation using Playwright.
 * Supports two modes:
 * - local: Launches a local headless browser (default)
 * - sandbox: Connects to a Docker sandbox via CDP (recommended for anti-detection)
 */
import {
  chromium,
  type Browser,
  type Page,
  type BrowserContext,
} from "playwright";

import { getConfig } from "../../lib/config-loader.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("browser", { component: "service" });

const BROWSER_MODE = getConfig().tools.browser.mode;
const BROWSER_CDP_URL = getConfig().tools.browser.cdpUrl;
const BROWSER_EXTRA_ARGS: string[] = (process.env.BROWSER_EXTRA_ARGS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 7_500;
const DEFAULT_CDP_RETRY_BUDGET = 2;
const DEFAULT_CDP_RETRY_DELAY_MS = 750;
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const browserViewportWidth = parsePositiveInt(
  process.env.BROWSER_VIEWPORT_WIDTH ?? process.env.BROWSER_WINDOW_WIDTH,
  DEFAULT_VIEWPORT_WIDTH,
);
const browserViewportHeight = parsePositiveInt(
  process.env.BROWSER_VIEWPORT_HEIGHT ?? process.env.BROWSER_WINDOW_HEIGHT,
  DEFAULT_VIEWPORT_HEIGHT,
);

const cdpConnectTimeoutMs = (() => {
  const raw = Number(process.env.BROWSER_CDP_CONNECT_TIMEOUT_MS ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CDP_CONNECT_TIMEOUT_MS;
})();

const cdpRetryBudget = (() => {
  const raw = Number(process.env.BROWSER_CDP_RETRY_BUDGET ?? DEFAULT_CDP_RETRY_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_CDP_RETRY_BUDGET;
})();

const cdpRetryDelayMs = (() => {
  const raw = Number(process.env.BROWSER_CDP_RETRY_DELAY_MS ?? DEFAULT_CDP_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CDP_RETRY_DELAY_MS;
})();

export const BROWSER_UNAVAILABLE_CODE = "BROWSER_UNAVAILABLE";

export class BrowserUnavailableError extends Error {
  readonly code = BROWSER_UNAVAILABLE_CODE;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BrowserUnavailableError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isBrowserUnavailableError(
  error: unknown,
): error is BrowserUnavailableError {
  if (error instanceof BrowserUnavailableError) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: unknown }).code === BROWSER_UNAVAILABLE_CODE;
}

function normalizeCdpUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BrowserStatus {
  running: boolean;
  url?: string;
  title?: string;
  tabCount: number;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface SnapshotResult {
  snapshot: string;
  refs: Record<string, { role: string; name?: string }>;
  url: string;
  title: string;
}

export interface ScreenshotResult {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export type BrowserAction =
  | { type: "click"; ref: string; button?: "left" | "right" | "middle" }
  | { type: "type"; ref: string; text: string; submit?: boolean }
  | { type: "fill"; ref: string; text: string }
  | { type: "hover"; ref: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "press"; key: string }
  | { type: "wait"; ms: number };

class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activePage: Page | null = null;
  private refMap = new Map<string, string>(); // ref -> selector
  private refCounter = 0;

  async start(): Promise<BrowserStatus> {
    if (this.browser) {
      return this.getStatus();
    }

    if (BROWSER_MODE === "sandbox") {
      const cdpUrl = normalizeCdpUrl(BROWSER_CDP_URL);
      log.info(
        {
          mode: BROWSER_MODE,
          cdpUrl,
          timeoutMs: cdpConnectTimeoutMs,
          retryBudget: cdpRetryBudget,
        },
        "Connecting to browser sandbox",
      );

      this.browser = await this.connectToSandbox(cdpUrl);

      // Get existing context or create new one
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.context = contexts[0];
        const pages = this.context.pages();
        if (pages.length > 0) {
          for (const page of pages) {
            await this.applyViewportSize(page);
          }
          this.pages = pages;
          this.activePage = pages[0];
        } else {
          this.activePage = await this.context.newPage();
          await this.applyViewportSize(this.activePage);
          this.pages.push(this.activePage);
        }
      } else {
        this.context = await this.browser.newContext({
          viewport: {
            width: browserViewportWidth,
            height: browserViewportHeight,
          },
        });
        this.activePage = await this.context.newPage();
        await this.applyViewportSize(this.activePage);
        this.pages.push(this.activePage);
      }

      log.info({ cdpUrl }, "Connected to browser sandbox");
    } else {
      log.info(
        { mode: BROWSER_MODE, extraArgsCount: BROWSER_EXTRA_ARGS.length },
        "Starting local browser",
      );
      this.browser = await chromium.launch({
        headless: true,
        ...(BROWSER_EXTRA_ARGS.length > 0 ? { args: BROWSER_EXTRA_ARGS } : {}),
      });

      this.context = await this.browser.newContext({
        viewport: {
          width: browserViewportWidth,
          height: browserViewportHeight,
        },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      this.activePage = await this.context.newPage();
      await this.applyViewportSize(this.activePage);
      this.pages.push(this.activePage);

      log.info("Local browser started");
    }

    return this.getStatus();
  }

  private async checkSandboxAvailable(cdpUrl: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cdpConnectTimeoutMs);
    try {
      const response = await fetch(`${cdpUrl}/json/version`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async connectToSandbox(cdpUrl: string): Promise<Browser> {
    let lastError: unknown;
    const maxAttempts = cdpRetryBudget + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isAvailable = await this.checkSandboxAvailable(cdpUrl);
      if (!isAvailable) {
        const message =
          `Browser sandbox is unavailable at ${cdpUrl}. ` +
          `Operator action: verify BROWSER_CDP_URL and start browser-sandbox (docker compose up browser-sandbox).`;
        lastError = new BrowserUnavailableError(message);
      } else {
        try {
          return await chromium.connectOverCDP(cdpUrl, {
            timeout: cdpConnectTimeoutMs,
          });
        } catch (error) {
          lastError = error;
          log.warn(
            { err: error, cdpUrl, attempt, maxAttempts },
            "CDP connect attempt failed",
          );
        }
      }

      if (attempt < maxAttempts) {
        await delay(cdpRetryDelayMs);
      }
    }

    if (isBrowserUnavailableError(lastError)) {
      throw lastError;
    }

    throw new BrowserUnavailableError(
      `Failed to connect to browser sandbox at ${cdpUrl}. ` +
        `Operator action: verify BROWSER_CDP_URL and start browser-sandbox (docker compose up browser-sandbox).`,
      lastError,
    );
  }

  async stop(): Promise<void> {
    if (this.browser) {
      if (BROWSER_MODE === "sandbox") {
        // In sandbox mode, just disconnect (don't close the browser)
        // Navigate to blank to reset state
        if (this.activePage) {
          await this.activePage.goto("about:blank").catch(() => {});
        }
        // Close extra pages but keep one
        for (let i = 1; i < this.pages.length; i++) {
          await this.pages[i].close().catch(() => {});
        }
        log.info("Disconnected from browser sandbox");
      } else {
        await this.browser.close();
        log.info("Local browser stopped");
      }
      this.browser = null;
      this.context = null;
      this.pages = [];
      this.activePage = null;
      this.refMap.clear();
    }
  }

  getStatus(): BrowserStatus {
    return {
      running: !!this.browser,
      url: this.activePage?.url(),
      title: undefined, // Will be set async if needed
      tabCount: this.pages.length,
    };
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    await this.ensureStarted();

    // Add protocol if missing
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    await this.activePage!.goto(url, { waitUntil: "domcontentloaded" });

    return {
      url: this.activePage!.url(),
      title: await this.activePage!.title(),
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    await this.ensureStarted();

    // Clear previous refs
    this.refMap.clear();
    this.refCounter = 0;

    const page = this.activePage!;

    // Build text representation with refs using Playwright locators
    const lines: string[] = [];
    const refs: Record<string, { role: string; name?: string }> = {};

    // Helper to add elements by role
    const addByRole = async (role: string, selector: string) => {
      const elements = page.locator(selector);
      const count = await elements.count();
      for (let i = 0; i < Math.min(count, 50); i++) {
        // Limit to 50 per type
        const el = elements.nth(i);
        const text = await el.textContent().catch(() => "");
        const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
        const placeholder = await el
          .getAttribute("placeholder")
          .catch(() => null);
        const name = (ariaLabel || placeholder || text || "")
          .trim()
          .slice(0, 50);

        const ref = `e${++this.refCounter}`;
        const displayName = name ? ` "${name}"` : "";
        lines.push(`[${ref}] ${role}${displayName}`);
        refs[ref] = { role, name: name || undefined };
        this.refMap.set(ref, `${selector} >> nth=${i}`);
      }
    };

    // Get interactive elements
    await addByRole("button", 'button, [role="button"]');
    await addByRole("link", "a[href]");
    await addByRole(
      "textbox",
      'input[type="text"], input[type="email"], input[type="password"], input[type="search"], input:not([type]), textarea'
    );
    await addByRole("checkbox", 'input[type="checkbox"]');
    await addByRole("combobox", "select");

    return {
      snapshot:
        lines.length > 0
          ? lines.join("\n")
          : "No interactive elements found on page.",
      refs,
      url: page.url(),
      title: await page.title(),
    };
  }

  async getContent(
    maxLength = 30000
  ): Promise<{ content: string; url: string; title: string }> {
    await this.ensureStarted();
    const page = this.activePage!;

    // Get visible text content from the page body
    const rawContent = await page.locator("body").innerText({ timeout: 10000 });

    // Truncate if needed
    let content = rawContent;
    if (content.length > maxLength) {
      content =
        content.slice(0, maxLength) + "\n\n[...TRUNCATED - page too large]";
    }

    return {
      content,
      url: page.url(),
      title: await page.title(),
    };
  }

  async screenshot(fullPage = false): Promise<ScreenshotResult> {
    await this.ensureStarted();

    const buffer = await this.activePage!.screenshot({
      fullPage,
      type: "png",
    });

    const viewport = this.activePage!.viewportSize() || {
      width: browserViewportWidth,
      height: browserViewportHeight,
    };

    return {
      base64: buffer.toString("base64"),
      mimeType: "image/png",
      width: viewport.width,
      height: viewport.height,
    };
  }

  async act(action: BrowserAction): Promise<string> {
    await this.ensureStarted();
    const page = this.activePage!;

    switch (action.type) {
      case "click": {
        const selector = this.resolveRef(action.ref);
        await page.click(selector, { button: action.button || "left" });
        return `Clicked ${action.ref}`;
      }

      case "type": {
        const selector = this.resolveRef(action.ref);
        await page.locator(selector).pressSequentially(action.text);
        if (action.submit) {
          await page.keyboard.press("Enter");
        }
        return `Typed "${action.text}" into ${action.ref}`;
      }

      case "fill": {
        const selector = this.resolveRef(action.ref);
        await page.fill(selector, action.text);
        return `Filled ${action.ref} with "${action.text}"`;
      }

      case "hover": {
        const selector = this.resolveRef(action.ref);
        await page.hover(selector);
        return `Hovered over ${action.ref}`;
      }

      case "scroll": {
        const delta =
          (action.amount || 500) * (action.direction === "up" ? -1 : 1);
        await page.mouse.wheel(0, delta);
        return `Scrolled ${action.direction} by ${Math.abs(delta)}px`;
      }

      case "press": {
        await page.keyboard.press(action.key);
        return `Pressed ${action.key}`;
      }

      case "wait": {
        await page.waitForTimeout(action.ms);
        return `Waited ${action.ms}ms`;
      }

      default:
        throw new Error(
          `Unknown action type: ${(action as { type: string }).type}`
        );
    }
  }

  async getTabs(): Promise<TabInfo[]> {
    await this.ensureStarted();

    const tabs: TabInfo[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      tabs.push({
        id: i,
        url: page.url(),
        title: await page.title(),
        active: page === this.activePage,
      });
    }
    return tabs;
  }

  async newTab(url?: string): Promise<TabInfo> {
    await this.ensureStarted();

    const page = await this.context!.newPage();
    await this.applyViewportSize(page);
    this.pages.push(page);
    this.activePage = page;

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    return {
      id: this.pages.length - 1,
      url: page.url(),
      title: await page.title(),
      active: true,
    };
  }

  async closeTab(tabId: number): Promise<boolean> {
    if (tabId < 0 || tabId >= this.pages.length) {
      return false;
    }

    const page = this.pages[tabId];
    await page.close();
    this.pages.splice(tabId, 1);

    if (this.activePage === page) {
      this.activePage = this.pages[0] || null;
    }

    return true;
  }

  async switchTab(tabId: number): Promise<boolean> {
    if (tabId < 0 || tabId >= this.pages.length) {
      return false;
    }

    this.activePage = this.pages[tabId];
    return true;
  }

  async savePdf(): Promise<{ path: string; bytes: number }> {
    await this.ensureStarted();
    const { join } = await import("node:path");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = join(process.cwd(), ".sandbox", "browser");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `page-${Date.now()}.pdf`);
    const buffer = await this.activePage!.pdf({ format: "A4" });
    await writeFile(filePath, buffer);
    return { path: filePath, bytes: buffer.length };
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<string> {
    await this.ensureStarted();
    const page = this.activePage!;
    page.once("dialog", async (dialog) => {
      if (accept) {
        await dialog.accept(promptText);
      } else {
        await dialog.dismiss();
      }
    });
    return accept ? "Will accept next dialog" : "Will dismiss next dialog";
  }

  async getConsoleMessages(_limit = 20): Promise<string[]> {
    // Console messages are ephemeral — we'd need to collect them continuously.
    // For now return a note about this limitation.
    return ["Console message collection requires prior setup. Use snapshot or content to inspect the page state."];
  }

  async setFileInput(ref: string, filePaths: string[]): Promise<string> {
    await this.ensureStarted();
    const page = this.activePage!;
    const selector = this.resolveRef(ref);
    await page.setInputFiles(selector, filePaths);
    return `Set ${filePaths.length} file(s) on ${ref}`;
  }

  async screenshotToFile(fullPage = false): Promise<{ path: string; width: number; height: number }> {
    await this.ensureStarted();
    const { join } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const dir = join(process.cwd(), ".sandbox", "browser");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `screenshot-${Date.now()}.png`);
    await this.activePage!.screenshot({ fullPage, path: filePath, type: "png" });
    const viewport = this.activePage!.viewportSize() || {
      width: browserViewportWidth,
      height: browserViewportHeight,
    };
    return { path: filePath, ...viewport };
  }

  private async applyViewportSize(page: Page): Promise<void> {
    try {
      await page.setViewportSize({
        width: browserViewportWidth,
        height: browserViewportHeight,
      });
    } catch (error) {
      log.debug(
        { err: error, width: browserViewportWidth, height: browserViewportHeight },
        "Unable to set browser viewport size",
      );
    }
  }

  private resolveRef(ref: string): string {
    // Clean ref (remove brackets if present)
    const cleanRef = ref.replace(/\[|\]/g, "");

    // Check if it's a stored ref
    const selector = this.refMap.get(cleanRef);
    if (selector) {
      return selector;
    }

    // If not found, assume it's a direct selector
    return ref;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.browser) {
      await this.start();
    }
  }
}

export const browserService = new BrowserService();
