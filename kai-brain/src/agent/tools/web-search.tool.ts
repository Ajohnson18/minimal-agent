/**
 * Web Search Tool
 *
 * Searches the web using Exa Search API.
 * Supports categories, domain filtering, freshness, highlights, and TTL caching.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { TtlCache } from "../../lib/web-cache.js";
import { wrapWebContent } from "../../lib/security/external-content.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const searchCache = new TtlCache<string>(100);

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results (1-10, default 5)",
      minimum: 1,
      maximum: 10,
    })
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        'Time filter: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year)',
    })
  ),
  country: Type.Optional(
    Type.String({
      description: "Country code for results (e.g. US, GB, DE)",
    })
  ),
  category: Type.Optional(
    Type.String({
      description:
        'Search a dedicated index: "news", "research paper", "tweet", "company", "people". Omit for general web search.',
    })
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Limit results to specific domains (e.g. ["github.com", "arxiv.org"]). Cannot be used with excludeDomains.',
    })
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Exclude specific domains (e.g. ["pinterest.com"]). Cannot be used with includeDomains.',
    })
  ),
  useHighlights: Type.Optional(
    Type.Boolean({
      description:
        "Return key excerpts instead of full text. Cheaper and faster, good for summaries and Q&A.",
    })
  ),
});

type WebSearchArgs = Static<typeof WebSearchSchema>;

interface ExaSearchResult {
  title: string;
  url: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
}

interface ExaSearchResponse {
  results: ExaSearchResult[];
}

/**
 * Map freshness filter to a startPublishedDate ISO string.
 */
function freshnessToDate(freshness: string): string | undefined {
  const now = Date.now();
  const msPerDay = 86400000;
  const offsets: Record<string, number> = {
    pd: msPerDay,
    pw: 7 * msPerDay,
    pm: 30 * msPerDay,
    py: 365 * msPerDay,
  };
  const offset = offsets[freshness];
  if (!offset) return undefined;
  return new Date(now - offset).toISOString();
}

export function createWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description: `Search the web for current information. Returns titles, URLs, and snippets.
Use this for quick factual lookups, finding documentation, checking current events, etc.
For reading full page content, follow up with web_fetch on interesting URLs.
Supports freshness filter (pd=past day, pw=past week, pm=past month) and country filter.
Supports category search: "news", "research paper", "tweet", "company", "people".
Supports domain filtering with includeDomains/excludeDomains.
Use useHighlights=true for key excerpts instead of full text (cheaper, faster).`,
    parameters: WebSearchSchema,
    execute: async (
      _toolCallId: string,
      args: WebSearchArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      // Check abort signal before executing
      if (_signal?.aborted) {
        return {
          content: [{ type: "text", text: "Web search aborted" }],
          details: { aborted: true },
        };
      }

      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Web search is not configured. EXA_API_KEY environment variable is missing. Use the browser tool to navigate to a search engine instead.",
            },
          ],
          details: { error: "EXA_API_KEY not set" },
        };
      }

      try {
        const count = args.count ?? 5;
        const cacheKey = `${args.query}|${count}|${args.freshness || ""}|${args.country || ""}|${args.category || ""}|${args.includeDomains?.join(",") || ""}|${args.excludeDomains?.join(",") || ""}|${args.useHighlights ? "hl" : ""}`;

        // Check cache
        const cached = searchCache.get(cacheKey);
        if (cached) {
          return {
            content: [{ type: "text", text: cached }],
            details: { query: args.query, cached: true },
          };
        }

        // Build Exa request body
        const useHighlights = args.useHighlights === true;
        const body: Record<string, unknown> = {
          query: args.query,
          type: "auto",
          num_results: count,
          contents: useHighlights
            ? { highlights: { max_characters: 500 } }
            : { text: { max_characters: 3000 } },
        };

        // Map freshness filter to startPublishedDate
        if (args.freshness) {
          const startDate = freshnessToDate(args.freshness);
          if (startDate) {
            body.startPublishedDate = startDate;
          }
          // Use livecrawl for past-day queries to get the freshest content
          if (args.freshness === "pd") {
            body.livecrawl = "preferred";
          }
        }

        // Category filter
        if (args.category) {
          body.category = args.category;
        }

        // Domain filtering (mutually exclusive)
        if (args.includeDomains?.length) {
          body.includeDomains = args.includeDomains;
        } else if (args.excludeDomains?.length) {
          body.excludeDomains = args.excludeDomains;
        }

        const response = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(
            `Exa API error: ${response.status} ${response.statusText}`
          );
        }

        const data = (await response.json()) as ExaSearchResponse;
        const results = data.results ?? [];

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results found for: ${args.query}`,
              },
            ],
            details: { query: args.query, count: 0 },
          };
        }

        const formatted = results
          .map((r, i) => {
            let snippet: string;
            if (useHighlights && r.highlights?.length) {
              snippet = r.highlights.join(" … ").slice(0, 500).trim();
            } else {
              snippet = r.text
                ? r.text.slice(0, 300).replace(/\n+/g, " ").trim()
                : "";
            }
            const datePart = r.publishedDate
              ? ` (${r.publishedDate.split("T")[0]})`
              : "";
            return `${i + 1}. ${wrapWebContent(r.title, "web_search")}${datePart}\n   ${r.url}\n   ${wrapWebContent(snippet, "web_search")}`;
          })
          .join("\n\n");

        const categoryLabel = args.category
          ? ` [${args.category}]`
          : "";
        const result = `Search results for "${args.query}"${categoryLabel}:\n\n${formatted}`;

        // Cache
        searchCache.set(cacheKey, result, CACHE_TTL_MS);

        return {
          content: [{ type: "text", text: result }],
          details: { query: args.query, count: results.length },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Web search error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
