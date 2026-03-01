import { afterEach, describe, expect, test, vi } from "vitest";

describe("integration: web tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EXA_API_KEY;
  });

  test("web_search handles errors and caches successful responses", async () => {
    process.env.EXA_API_KEY = "exa-test-key";
    vi.resetModules();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "Result A",
            url: "https://example.com/a",
            text: "Summary A",
          },
        ],
      }),
    } as Response);

    const { createWebSearchTool } =
      await import("../../../src/agent/tools/web-search.tool.js");

    const tool = createWebSearchTool();
    const first = await tool.execute("call-1", {
      query: "ava agent",
      count: 1,
    });
    const second = await tool.execute("call-2", {
      query: "ava agent",
      count: 1,
    });

    const firstText =
      first.content[0]?.type === "text" ? first.content[0].text : "";
    const secondText =
      second.content[0]?.type === "text" ? second.content[0].text : "";

    expect(firstText).toContain("Search results for");
    expect(secondText).toContain("Search results for");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRestore();

    delete process.env.EXA_API_KEY;
    const missingKey = await tool.execute("call-3", { query: "x" });
    const missingText =
      missingKey.content[0]?.type === "text" ? missingKey.content[0].text : "";
    expect(missingText).toContain("EXA_API_KEY");
  });

  test("web_fetch blocks ssrf targets and caches successful fetches", async () => {
    vi.resetModules();

    const { createWebFetchTool } =
      await import("../../../src/agent/tools/web-fetch.tool.js");

    const tool = createWebFetchTool();

    const blocked = await tool.execute("fetch-1", {
      url: "http://localhost:9222",
    });
    const blockedText =
      blocked.content[0]?.type === "text" ? blocked.content[0].text : "";
    expect(blockedText).toContain("SSRF");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({
        "content-type": "text/html",
      }),
      text: async () =>
        "<html><head><title>Doc</title></head><body><article><p>Hello world</p></article></body></html>",
    } as Response);

    const first = await tool.execute("fetch-2", {
      url: "https://raw.githubusercontent.com/arman/ava-agent",
    });
    const second = await tool.execute("fetch-3", {
      url: "https://raw.githubusercontent.com/arman/ava-agent",
    });

    const firstText =
      first.content[0]?.type === "text" ? first.content[0].text : "";
    const secondText =
      second.content[0]?.type === "text" ? second.content[0].text : "";

    expect(firstText).toContain("URL:");
    expect(secondText).toContain("URL:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
