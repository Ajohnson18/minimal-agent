/**
 * Test script for new features added in the feature additions plan.
 * Validates: tool registration, system prompt, process registry,
 * exec tool, web-fetch, schema compatibility.
 *
 * Does NOT require Docker, database, or external APIs.
 *
 * Usage: npx tsx src/scripts/test-new-features.ts
 */

const CTX = undefined as any;

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  ${name}... `);

  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    console.log(`OK (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    results.push({ name, passed: false, duration, error: errorMsg });
    console.log(`FAILED`);
    console.log(`    Error: ${errorMsg}`);
  }
}

async function main() {
  console.log("\n===================================================");
  console.log("        AVA New Features Test Suite");
  console.log("===================================================\n");

  // ──────────────────────────────────────────────
  // 1. System Prompt
  // ──────────────────────────────────────────────
  console.log("1. System Prompt");
  console.log("---------------------------------------------------");

  await runTest("Build full system prompt", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "test-user",
      sessionId: "test-session",
      promptMode: "full",
      toolNames: [
        "read", "write", "edit", "grep", "find", "ls",
        "exec", "process", "web_search", "web_fetch",
        "browser", "python_exec", "sql_query", "memory",
        "spawn_subagent", "schedule", "slack_message",
        "slack_actions", "get_current_time", "get_session_info",
      ],
      modelId: "gemini-2.0-flash",
      channel: "slack",
      workspaceDir: "/workspace",
    });

    if (!prompt.includes("Kai")) throw new Error("Missing identity");
    if (!prompt.includes("## Tooling")) throw new Error("Missing tooling section");
    if (!prompt.includes("## Safety")) throw new Error("Missing safety section");
    if (!prompt.includes("## Tool Call Style")) throw new Error("Missing tool call style");
    if (!prompt.includes("## Silent Replies")) throw new Error("Missing silent replies");
    if (!prompt.includes("Runtime:")) throw new Error("Missing runtime line");
    if (!prompt.includes("exec:")) throw new Error("Missing exec tool");
    if (!prompt.includes("web_search:")) throw new Error("Missing web_search tool");
    if (!prompt.includes("memory:")) throw new Error("Missing memory tool");
    if (!prompt.includes("sql_query:")) throw new Error("Missing sql_query tool");
    if (!prompt.includes("## Memory Recall")) throw new Error("Missing memory recall section");
    if (!prompt.includes("## Tool Call Style")) throw new Error("Missing tool call style section");
    if (!prompt.includes("## Reactions")) throw new Error("Missing reactions section");
  });

  await runTest("Build minimal system prompt (subagent)", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "test-user",
      sessionId: "test-session",
      promptMode: "minimal",
      toolNames: ["read", "write", "edit", "exec"],
    });

    if (!prompt.includes("Kai")) throw new Error("Missing identity");
    if (!prompt.includes("## Safety")) throw new Error("Safety should always be included");
    // Minimal mode should NOT have these
    if (prompt.includes("## Silent Replies")) throw new Error("Minimal should skip silent replies");
    if (prompt.includes("## Reactions")) throw new Error("Minimal should skip reactions");
    if (prompt.includes("## Memory Recall")) throw new Error("Minimal should skip memory");
  });

  await runTest("Build none mode prompt", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "test-user",
      sessionId: "test-session",
      promptMode: "none",
    });

    if (!prompt.includes("Kai")) throw new Error("Missing identity");
    if (prompt.includes("## Tooling")) throw new Error("None mode should have no sections");
  });

  await runTest("Thinking mode adds reasoning section", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "test-user",
      sessionId: "test-session",
      promptMode: "full",
      toolNames: ["read"],
      thinkingLevel: "high",
    });

    if (!prompt.includes("## Reasoning Format")) throw new Error("Missing reasoning section");
    if (!prompt.includes("<think>")) throw new Error("Missing think tags");
  });

  await runTest("Skills context injected", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "test-user",
      sessionId: "test-session",
      promptMode: "full",
      toolNames: ["read"],
      skillsContext: '<available_skills><skill name="test"><description>Test skill</description></skill></available_skills>',
    });

    if (!prompt.includes("## Skills (mandatory)")) throw new Error("Missing skills section");
    if (!prompt.includes("available_skills")) throw new Error("Missing skills context");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 2. Tool Registration
  // ──────────────────────────────────────────────
  console.log("2. Tool Registration");
  console.log("---------------------------------------------------");

  await runTest("Built-in tools exclude bash", async () => {
    const { getBuiltInTools } = await import("../agent/pi-converter.js");
    const tools = getBuiltInTools();
    const names = tools.map((t) => t.name);
    console.log(`\n    Built-in tools: ${names.join(", ")}`);
    if (names.includes("bash")) throw new Error("bash should be filtered out");
    if (!names.includes("read")) throw new Error("read should be present");
    // At minimum we need read + some file tools
    if (names.length < 2) throw new Error(`Expected multiple built-in tools, got ${names.length}`);
  });

  await runTest("Custom tools include all new tools", async () => {
    const { createCustomTools } = await import("../agent/pi-converter.js");
    const tools = createCustomTools({ userId: "test", sessionId: "test" });
    const names = tools.map((t) => t.name);

    const expected = [
      "exec", "process", "web_search", "web_fetch",
      "browser", "python_exec", "slack_actions", "slack_message",
      "memory", "sql_query", "spawn_subagent", "schedule",
      "get_current_time", "get_session_info",
    ];

    for (const name of expected) {
      if (!names.includes(name)) throw new Error(`Missing tool: ${name}`);
    }
    console.log(`\n    Found ${names.length} custom tools: ${names.join(", ")}`);
  });

  await runTest("Tool schemas are Vertex AI compatible", async () => {
    const { createCustomTools } = await import("../agent/pi-converter.js");
    const tools = createCustomTools({ userId: "test", sessionId: "test" });

    for (const tool of tools) {
      const schema = JSON.stringify(tool.parameters);
      if (schema.includes("patternProperties")) {
        throw new Error(`Tool "${tool.name}" has patternProperties (breaks Vertex AI)`);
      }
    }
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 3. Process Registry
  // ──────────────────────────────────────────────
  console.log("3. Process Registry");
  console.log("---------------------------------------------------");

  await runTest("Create and track sessions", async () => {
    const {
      createEmptySession, addSession, getSession, listSessions,
      markBackgrounded, markExited, clearFinished,
    } = await import("../agent/tools/process-registry.js");

    const session = createEmptySession("test-1", "echo hello");
    addSession(session);

    const found = getSession("test-1");
    if (!found) throw new Error("Session not found after add");

    const { running } = listSessions();
    if (running.length === 0) throw new Error("No running sessions listed");

    // Background and exit
    markBackgrounded(session);
    markExited(session, 0, null, "completed");

    const foundAfter = getSession("test-1");
    if (foundAfter) throw new Error("Session should be moved to finished");

    const { finished } = listSessions();
    if (finished.length === 0) throw new Error("No finished sessions after exit");

    clearFinished("test-1");
  });

  await runTest("Append and drain output", async () => {
    const {
      createEmptySession, addSession, appendOutput, drainSession, killSession,
    } = await import("../agent/tools/process-registry.js");

    const session = createEmptySession("test-2", "cat file");
    addSession(session);

    appendOutput(session, "stdout", "line 1\n");
    appendOutput(session, "stdout", "line 2\n");
    appendOutput(session, "stderr", "warning\n");

    const { stdout, stderr } = drainSession(session);
    if (!stdout.includes("line 1")) throw new Error("Missing stdout content");
    if (!stderr.includes("warning")) throw new Error("Missing stderr content");

    // Drain again — should be empty
    const { stdout: s2 } = drainSession(session);
    if (s2.length > 0) throw new Error("Drain should empty pending");

    // Aggregated should still have everything
    if (!session.aggregated.includes("line 1")) throw new Error("Missing aggregated");

    killSession("test-2");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 4. Exec Tool
  // ──────────────────────────────────────────────
  console.log("4. Exec Tool");
  console.log("---------------------------------------------------");

  await runTest("Execute simple command", async () => {
    const { createExecTool } = await import("../agent/tools/exec.tool.js");
    const tool = createExecTool();
    const result = await tool.execute("test", { command: "echo hello world" }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    if (!text.includes("hello world")) throw new Error(`Unexpected output: ${text}`);
  });

  await runTest("Execute with immediate background", async () => {
    const { createExecTool } = await import("../agent/tools/exec.tool.js");
    const { clearFinished, killSession } = await import("../agent/tools/process-registry.js");
    const tool = createExecTool();
    const result = await tool.execute("test", { command: "sleep 10", background: true }, undefined, undefined, CTX);
    const details = result.details as { status: string; sessionId: string };
    if (details.status !== "running") throw new Error(`Expected running, got ${details.status}`);
    if (!details.sessionId) throw new Error("Missing sessionId");
    // Kill and cleanup
    killSession(details.sessionId);
    clearFinished(details.sessionId);
  });

  await runTest("Execute with timeout", async () => {
    const { createExecTool } = await import("../agent/tools/exec.tool.js");
    const tool = createExecTool();
    // Run a fast command with generous timeout
    const result = await tool.execute("test", {
      command: "echo done",
      timeout: 5,
      yieldMs: 30000, // don't yield
    }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    if (!text.includes("done")) throw new Error(`Unexpected: ${text}`);
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 5. Process Tool
  // ──────────────────────────────────────────────
  console.log("5. Process Tool");
  console.log("---------------------------------------------------");

  await runTest("List sessions", async () => {
    const { createProcessTool } = await import("../agent/tools/process.tool.js");
    const tool = createProcessTool();
    const result = await tool.execute("test", { action: "list" }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    // Just verify it doesn't crash — may have leftover sessions from prior tests
    if (!text) throw new Error("Empty response from list");
  });

  await runTest("Background exec then read log", async () => {
    const { createExecTool } = await import("../agent/tools/exec.tool.js");
    const { createProcessTool } = await import("../agent/tools/process.tool.js");
    const { killSession, clearFinished } = await import("../agent/tools/process-registry.js");

    const execTool = createExecTool();
    const processTool = createProcessTool();

    // Start a command that outputs and exits quickly
    const execResult = await execTool.execute("test", {
      command: "echo polling-test && sleep 0.1 && echo done-test",
      background: true,
    }, undefined, undefined, CTX);
    const sessionId = (execResult.details as { sessionId: string }).sessionId;

    // Wait for the command to finish
    await new Promise((r) => setTimeout(r, 500));

    // Use log action (works for both running and finished sessions)
    const logResult = await processTool.execute("test", {
      action: "log",
      sessionId,
    }, undefined, undefined, CTX);
    const logText = (logResult.content[0] as { type: string; text: string }).text;
    if (!logText.includes("polling-test")) throw new Error(`Log missing output: ${logText}`);

    // Cleanup
    killSession(sessionId);
    clearFinished(sessionId);
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 6. Web Fetch Tool
  // ──────────────────────────────────────────────
  console.log("6. Web Fetch Tool");
  console.log("---------------------------------------------------");

  await runTest("Fetch a real URL", async () => {
    const { createWebFetchTool } = await import("../agent/tools/web-fetch.tool.js");
    const tool = createWebFetchTool();
    const result = await tool.execute("test", {
      url: "https://httpbin.org/html",
      timeoutSeconds: 10,
    }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    if (!text.includes("Herman Melville")) throw new Error(`Unexpected content: ${text.slice(0, 200)}`);
  });

  await runTest("Fetch JSON endpoint", async () => {
    const { createWebFetchTool } = await import("../agent/tools/web-fetch.tool.js");
    const tool = createWebFetchTool();
    const result = await tool.execute("test", {
      url: "https://httpbin.org/json",
      timeoutSeconds: 10,
    }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    if (!text.includes("slideshow")) throw new Error(`Unexpected JSON: ${text.slice(0, 200)}`);
  });

  await runTest("Handle bad URL gracefully", async () => {
    const { createWebFetchTool } = await import("../agent/tools/web-fetch.tool.js");
    const tool = createWebFetchTool();
    const result = await tool.execute("test", {
      url: "https://thisdoesnotexist-abc123.com",
      timeoutSeconds: 5,
    }, undefined, undefined, CTX);
    const text = (result.content[0] as { type: string; text: string }).text;
    if (!text.includes("error")) throw new Error("Should have error message");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 7. Web Search Tool
  // ──────────────────────────────────────────────
  console.log("7. Web Search Tool");
  console.log("---------------------------------------------------");

  await runTest("Handles missing API key gracefully", async () => {
    const origKey = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    try {
      const { createWebSearchTool } = await import("../agent/tools/web-search.tool.js");
      const tool = createWebSearchTool();
      const result = await tool.execute("test", { query: "test" }, undefined, undefined, CTX);
      const text = (result.content[0] as { type: string; text: string }).text;
      if (!text.includes("not configured") && !text.includes("EXA_API_KEY")) {
        throw new Error(`Should mention missing key: ${text}`);
      }
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey;
    }
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 8. Media Service
  // ──────────────────────────────────────────────
  console.log("8. Media Service");
  console.log("---------------------------------------------------");

  await runTest("Format media context", async () => {
    const { formatMediaContext } = await import("../services/media.service.js");
    const ctx = formatMediaContext([
      { fileName: "test.png", type: "image", description: "A cat sitting" },
      { fileName: "note.mp3", type: "audio", description: "Hello there" },
    ]);
    if (!ctx) throw new Error("Context should not be null");
    if (!ctx.includes("Image: test.png")) throw new Error("Missing image context");
    if (!ctx.includes("Audio Transcription: note.mp3")) throw new Error("Missing audio context");
    if (!ctx.includes("A cat sitting")) throw new Error("Missing image description");
  });

  await runTest("Handle empty media results", async () => {
    const { formatMediaContext } = await import("../services/media.service.js");
    const ctx = formatMediaContext([]);
    if (ctx !== null) throw new Error("Should return null for empty");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 9. SSRF Protection
  // ──────────────────────────────────────────────
  console.log("9. SSRF Protection");
  console.log("---------------------------------------------------");

  await runTest("Block localhost", async () => {
    const { validateUrl } = await import("../lib/ssrf-guard.js");
    try {
      await validateUrl("http://localhost:8080/secret");
      throw new Error("Should have blocked localhost");
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("Blocked") && !msg.includes("not allowed")) throw e;
    }
  });

  await runTest("Block private IPs", async () => {
    const { validateUrl } = await import("../lib/ssrf-guard.js");
    for (const ip of ["http://10.0.0.1", "http://192.168.1.1", "http://127.0.0.1", "http://169.254.169.254"]) {
      try {
        await validateUrl(ip);
        throw new Error(`Should have blocked ${ip}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.includes("Blocked") && !msg.includes("not allowed")) throw e;
      }
    }
  });

  await runTest("Block non-HTTP schemes", async () => {
    const { validateUrl } = await import("../lib/ssrf-guard.js");
    try {
      await validateUrl("ftp://example.com/file");
      throw new Error("Should have blocked ftp");
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("Blocked") && !msg.includes("only http")) throw e;
    }
  });

  await runTest("Allow public URLs", async () => {
    const { validateUrl } = await import("../lib/ssrf-guard.js");
    await validateUrl("https://google.com");
    await validateUrl("https://httpbin.org/get");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 10. System Prompt - New Sections
  // ──────────────────────────────────────────────
  console.log("10. System Prompt - Gap Sections");
  console.log("---------------------------------------------------");

  await runTest("Heartbeat section", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
    });
    if (!prompt.includes("HEARTBEAT_OK")) throw new Error("Missing heartbeat");
  });

  await runTest("Reply tags stripped from output", async () => {
    const { sanitizeAssistantOutput } = await import("../agent/sanitize-output.js");
    const input = "Here is your answer.\n[[reply_to_current]]\nMore text.";
    const output = sanitizeAssistantOutput(input);
    if (output.includes("[[reply_to")) throw new Error("Reply tag not stripped");
  });

  await runTest("Silent reply examples", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
    });
    if (!prompt.includes('Wrong: "Here')) throw new Error("Missing wrong example");
    if (!prompt.includes("Right: NO_REPLY")) throw new Error("Missing right example");
  });

  await runTest("Safety section has internal/external model", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
    });
    if (!prompt.includes("no independent goals")) throw new Error("Missing constitutional safety clause");
    if (!prompt.includes("Do not manipulate")) throw new Error("Missing anti-manipulation clause");
  });

  await runTest("Timezone section", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
      userTimezone: "America/New_York",
    });
    if (!prompt.includes("America/New_York")) throw new Error("Missing timezone");
  });

  await runTest("Context file injection with SOUL.md", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
      contextFiles: [
        { path: "SOUL.md", content: "Be friendly and helpful." },
        { path: "TEAM.md", content: "Team prefers concise answers." },
      ],
    });
    if (!prompt.includes("# Project Context")) throw new Error("Missing project context");
    if (!prompt.includes("embody its persona")) throw new Error("Missing SOUL.md instruction");
    if (!prompt.includes("Be friendly")) throw new Error("Missing SOUL content");
    if (!prompt.includes("TEAM.md")) throw new Error("Missing TEAM.md");
  });

  await runTest("Reasoning format with <final>", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
      thinkingLevel: "high",
    });
    if (!prompt.includes("<final>")) throw new Error("Missing <final> tag");
  });

  await runTest("Runtime line includes thinking and capabilities", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
      thinkingLevel: "high",
      capabilities: ["inlineButtons"],
    });
    if (!prompt.includes("thinking=high")) throw new Error("Missing thinking in runtime");
    if (!prompt.includes("capabilities=inlineButtons")) throw new Error("Missing capabilities");
  });

  await runTest("Reaction modes: extensive", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["read"],
      reactionMode: "extensive",
    });
    if (!prompt.includes("react liberally")) throw new Error("Missing extensive mode");
  });

  await runTest("Memory citations mode: on", async () => {
    const { buildSystemPrompt } = await import("../agent/system-prompt.js");
    const prompt = buildSystemPrompt({
      userId: "u", sessionId: "s", promptMode: "full", toolNames: ["memory"],
      citationsMode: "on",
    });
    if (!prompt.includes("Citations: include Source")) throw new Error("Missing citations on");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 11. Process Tool - New Actions
  // ──────────────────────────────────────────────
  console.log("11. Process Tool - New Actions");
  console.log("---------------------------------------------------");

  await runTest("Encode key sequences", async () => {
    const { encodeKeySequence } = await import("../agent/tools/process-registry.js");
    const result = encodeKeySequence(["Ctrl-C", "Enter"]);
    if (result !== "\x03\r") throw new Error(`Unexpected: ${JSON.stringify(result)}`);
  });

  await runTest("Encode paste with brackets", async () => {
    const { encodePaste } = await import("../agent/tools/process-registry.js");
    const result = encodePaste("hello", true);
    if (!result.includes("\x1B[200~")) throw new Error("Missing bracket start");
    if (!result.includes("hello")) throw new Error("Missing text");
    if (!result.includes("\x1B[201~")) throw new Error("Missing bracket end");
  });

  await runTest("Binary output sanitization", async () => {
    const { sanitizeBinaryOutput } = await import("../agent/tools/process-registry.js");
    const clean = sanitizeBinaryOutput("hello\x00world\x07test\ttab\nnewline");
    if (clean.includes("\x00")) throw new Error("Should strip null byte");
    if (clean.includes("\x07")) throw new Error("Should strip bell");
    if (!clean.includes("\t")) throw new Error("Should keep tab");
    if (!clean.includes("\n")) throw new Error("Should keep newline");
    if (!clean.includes("hello")) throw new Error("Should keep text");
  });

  await runTest("Pending buffer cap", async () => {
    const { createEmptySession, addSession, appendOutput, drainSession, killSession } =
      await import("../agent/tools/process-registry.js");
    const session = createEmptySession("test-cap", "cat");
    addSession(session);

    // Append more than pendingMaxOutputChars (30KB default)
    const bigChunk = "x".repeat(35_000);
    appendOutput(session, "stdout", bigChunk);

    const { stdout } = drainSession(session);
    // Should be capped, not the full 35KB
    if (stdout.length >= 35_000) throw new Error(`Pending not capped: ${stdout.length}`);
    killSession("test-cap");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 12. Web Cache
  // ──────────────────────────────────────────────
  console.log("12. Web Cache");
  console.log("---------------------------------------------------");

  await runTest("TTL cache set and get", async () => {
    const { TtlCache } = await import("../lib/web-cache.js");
    const cache = new TtlCache<string>(10);
    cache.set("key1", "value1", 5000);
    const v = cache.get("key1");
    if (v !== "value1") throw new Error(`Expected value1, got ${v}`);
  });

  await runTest("TTL cache expiry", async () => {
    const { TtlCache } = await import("../lib/web-cache.js");
    const cache = new TtlCache<string>(10);
    cache.set("key2", "value2", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    const v = cache.get("key2");
    if (v !== undefined) throw new Error("Should have expired");
  });

  await runTest("TTL cache LRU eviction", async () => {
    const { TtlCache } = await import("../lib/web-cache.js");
    const cache = new TtlCache<string>(3); // max 3
    cache.set("a", "1", 60000);
    cache.set("b", "2", 60000);
    cache.set("c", "3", 60000);
    cache.set("d", "4", 60000); // should evict "a"
    if (cache.get("a") !== undefined) throw new Error("a should be evicted");
    if (cache.get("d") !== "4") throw new Error("d should exist");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // 13. Media Service - New Types
  // ──────────────────────────────────────────────
  console.log("13. Media Service - Video & Skip");
  console.log("---------------------------------------------------");

  await runTest("Video type in format context", async () => {
    const { formatMediaContext } = await import("../services/media.service.js");
    const ctx = formatMediaContext([
      { fileName: "clip.mp4", type: "video", description: "A person walking" },
    ]);
    if (!ctx) throw new Error("Context should not be null");
    if (!ctx.includes("Video: clip.mp4")) throw new Error("Missing video label");
  });

  await runTest("Vision-skip excluded from context", async () => {
    const { formatMediaContext } = await import("../services/media.service.js");
    const ctx = formatMediaContext([
      { fileName: "photo.png", type: "image", description: "skip", skipped: true },
    ]);
    if (ctx !== null) throw new Error("Skipped images should not appear in context");
  });

  console.log("");

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
  console.log("===================================================");
  console.log("                    SUMMARY");
  console.log("===================================================");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n  Total: ${results.length} tests`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${(totalTime / 1000).toFixed(1)}s\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    - ${r.name}: ${r.error}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log("  All tests passed!\n");
  process.exit(0);
}

main().catch((error) => {
  console.error("\nFatal error:", error);
  process.exit(1);
});
