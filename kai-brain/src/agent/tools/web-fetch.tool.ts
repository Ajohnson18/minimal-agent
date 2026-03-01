/**
 * Web Fetch Tool
 *
 * Fetches a URL and extracts readable text content.
 * Features: SSRF protection, Readability extraction, TTL caching.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { validateUrl } from "../../lib/ssrf-guard.js";
import { wrapWebContent } from "../../lib/security/external-content.js";
import { TtlCache } from "../../lib/web-cache.js";

const MAX_CONTENT_LENGTH = 50_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const LLMS_TXT_MAX_LENGTH = 10_000;

const fetchCache = new TtlCache<string>(100);
const llmsTxtCache = new TtlCache<string | null>(200);

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "URL to fetch and extract content from" }),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (default 15)",
      minimum: 1,
      maximum: 60,
    })
  ),
});

type WebFetchArgs = Static<typeof WebFetchSchema>;

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Fallback HTML-to-text using regex (when Readability fails).
 */
function htmlToTextFallback(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract readable content using Mozilla Readability + linkedom.
 */
async function extractWithReadability(
  html: string,
  _url: string
): Promise<{ title: string | null; content: string } | null> {
  try {
    const { Readability } = await import("@mozilla/readability");
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(html);
    const reader = new Readability(document as any);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 100) {
      return { title: article.title || null, content: article.textContent.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch a URL and extract its readable text content.
Use this to read articles, documentation, web pages, API responses, etc.
For JSON APIs, the raw JSON is returned directly.
Content is capped at ~50k characters.`,
    parameters: WebFetchSchema,
    execute: async (
      _toolCallId: string,
      args: WebFetchArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (_signal?.aborted) {
        return {
          content: [{ type: "text", text: "Web fetch aborted" }],
          details: { aborted: true },
        };
      }

      try {
        let url = args.url;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          url = `https://${url}`;
        }

        // SSRF protection
        await validateUrl(url);

        // Check cache
        const cached = fetchCache.get(url);
        if (cached) {
          return {
            content: [{ type: "text", text: cached }],
            details: { url, cached: true },
          };
        }

        const timeoutMs = (args.timeoutSeconds ?? 15) * 1000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        // Request text/markdown first (Cloudflare "Markdown for Agents" support)
        // Falls back to HTML → Readability → regex extraction
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; AVA-Agent/1.0; +https://somethings.com)",
            Accept:
              "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.5",
          },
          redirect: "follow",
        });

        clearTimeout(timer);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") || "";
        const markdownTokens = response.headers.get("x-markdown-tokens");
        if (markdownTokens) {
          console.log(`[web_fetch] Cloudflare markdown tokens: ${markdownTokens}`);
        }
        const body = await response.text();

        let content: string;
        let title: string | null = null;

        if (contentType.includes("application/json")) {
          content = body.slice(0, MAX_CONTENT_LENGTH);
        } else if (contentType.includes("text/markdown") || contentType.includes("cf-markdown")) {
          // Cloudflare Markdown for Agents — clean markdown, use directly
          // Extract title from first heading if present
          const headingMatch = body.match(/^#\s+(.+)$/m);
          title = headingMatch ? headingMatch[1].trim() : null;
          content = body.slice(0, MAX_CONTENT_LENGTH);
        } else if (contentType.includes("text/html")) {
          // Try Readability first, fall back to regex
          const readable = await extractWithReadability(body, url);
          if (readable) {
            title = readable.title;
            content = readable.content.slice(0, MAX_CONTENT_LENGTH);
          } else {
            title = extractTitle(body);
            content = htmlToTextFallback(body).slice(0, MAX_CONTENT_LENGTH);
          }
        } else {
          content = body.slice(0, MAX_CONTENT_LENGTH);
        }

        // Attempt llms.txt discovery for the domain (cached per-origin)
        let llmsTxtBlock = "";
        try {
          const urlObj = new URL(url);
          const origin = urlObj.origin;
          // Skip non-site URLs (raw file hosts, API endpoints)
          const skipHosts = ["raw.githubusercontent.com", "api.github.com", "gist.githubusercontent.com"];
          if (!skipHosts.includes(urlObj.hostname)) {
            const cached = llmsTxtCache.get(origin);
            if (cached === undefined) {
              // Not cached yet — fetch
              const llmsUrl = `${origin}/llms.txt`;
              try {
                const llmsCtrl = new AbortController();
                const llmsTimer = setTimeout(() => llmsCtrl.abort(), 3000);
                const llmsRes = await fetch(llmsUrl, {
                  signal: llmsCtrl.signal,
                  headers: { "User-Agent": "AVA-Agent/1.0 (llms.txt discovery)" },
                });
                clearTimeout(llmsTimer);
                if (llmsRes.ok) {
                  const llmsBody = await llmsRes.text();
                  if (llmsBody.length > 0 && llmsBody.length <= LLMS_TXT_MAX_LENGTH) {
                    llmsTxtCache.set(origin, llmsBody, CACHE_TTL_MS);
                    llmsTxtBlock = `[Site Context from llms.txt]\n${llmsBody}\n\n`;
                  } else {
                    llmsTxtCache.set(origin, null, CACHE_TTL_MS);
                  }
                } else {
                  llmsTxtCache.set(origin, null, CACHE_TTL_MS);
                }
              } catch {
                llmsTxtCache.set(origin, null, CACHE_TTL_MS);
              }
            } else if (cached) {
              llmsTxtBlock = `[Site Context from llms.txt]\n${cached}\n\n`;
            }
          }
        } catch {
          // URL parse failure, skip llms.txt
        }

        const isMarkdown = contentType.includes("text/markdown") || contentType.includes("cf-markdown");
        const header = title
          ? `Title: ${title}\nURL: ${url}\n\n`
          : `URL: ${url}\n\n`;
        // Markdown responses are already clean — skip the external content wrapper noise
        const wrappedContent = isMarkdown
          ? `[Semantically compressed from ${body.length} chars]\n\n${content}`
          : wrapWebContent(content, "web_fetch");
        const result = header + llmsTxtBlock + wrappedContent;

        // Cache the result
        fetchCache.set(url, result, CACHE_TTL_MS);

        return {
          content: [{ type: "text", text: result }],
          details: { url, title, contentLength: content.length, contentType },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Web fetch error: ${message}` }],
          details: { error: message, url: args.url },
        };
      }
    },
  };
}
