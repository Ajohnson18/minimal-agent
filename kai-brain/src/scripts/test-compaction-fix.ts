/**
 * Test script for the event-driven compaction fix.
 *
 * Validates that assistant text and tool call extraction works correctly
 * in both normal and post-compaction scenarios
 *
 * Does NOT require Docker, database, or external APIs.
 *
 * Usage: npx tsx src/scripts/test-compaction-fix.ts
 */

import type { Message, AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  extractAssistantText,
  extractToolCalls,
  filterToMessages,
} from "../agent/session-adapter.js";
import { sanitizeAssistantOutput } from "../agent/sanitize-output.js";

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

function makeAssistantMessage(
  text: string,
  toolCalls?: ToolCall[],
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  if (toolCalls) {
    content.push(...toolCalls);
  }
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolCall(name: string, id?: string): ToolCall {
  return {
    type: "toolCall",
    id: id ?? `call_${name}_${Date.now()}`,
    name,
    arguments: {},
  };
}

function makeUserMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

// Simulates the event-driven collection logic from executor-pi.ts
function simulateEventCollection(events: AgentSessionEvent[]): {
  assistantTexts: string[];
  toolCalls: ToolCall[];
  didCompact: boolean;
} {
  const collectedAssistantTexts: string[] = [];
  const collectedToolCalls: ToolCall[] = [];
  let didCompact = false;

  for (const event of events) {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractAssistantText([event.message as Message]);
      if (text) collectedAssistantTexts.push(text);
      const calls = extractToolCalls([event.message as Message]);
      if (calls.length > 0) collectedToolCalls.push(...calls);
    }
    if (event.type === "auto_compaction_end") {
      didCompact = true;
    }
  }

  return {
    assistantTexts: collectedAssistantTexts,
    toolCalls: collectedToolCalls,
    didCompact,
  };
}

async function main() {
  console.log("\n===================================================");
  console.log("     Compaction Fix Test Suite (Event-Driven)");
  console.log("===================================================\n");

  // ─── 1. Basic extraction still works ───
  console.log("1. Basic Extraction (no compaction)");
  console.log("---------------------------------------------------");

  await runTest("extractAssistantText from single message", async () => {
    const msg = makeAssistantMessage("Hello world");
    const text = extractAssistantText([msg]);
    if (text !== "Hello world")
      throw new Error(`Expected "Hello world", got "${text}"`);
  });

  await runTest("extractAssistantText returns last assistant", async () => {
    const msg1 = makeAssistantMessage("First");
    const msg2 = makeAssistantMessage("Second");
    const text = extractAssistantText([msg1, msg2]);
    if (text !== "Second") throw new Error(`Expected "Second", got "${text}"`);
  });

  await runTest(
    "extractAssistantText returns empty for no messages",
    async () => {
      const text = extractAssistantText([]);
      if (text !== "") throw new Error(`Expected "", got "${text}"`);
    },
  );

  await runTest("extractToolCalls collects tool calls", async () => {
    const tc = makeToolCall("read");
    const msg = makeAssistantMessage("", [tc]);
    const calls = extractToolCalls([msg]);
    if (calls.length !== 1)
      throw new Error(`Expected 1 tool call, got ${calls.length}`);
    if (calls[0].name !== "read")
      throw new Error(`Expected "read", got "${calls[0].name}"`);
  });

  await runTest("sanitizeAssistantOutput strips thinking tags", async () => {
    const input = "<think>reasoning</think>Final answer";
    const output = sanitizeAssistantOutput(input);
    if (output !== "Final answer")
      throw new Error(`Expected "Final answer", got "${output}"`);
  });

  await runTest("sanitizeAssistantOutput handles empty string", async () => {
    const output = sanitizeAssistantOutput("");
    if (output !== "") throw new Error(`Expected "", got "${output}"`);
  });

  // ─── 2. Event-driven collection ───
  console.log("\n2. Event-Driven Collection");
  console.log("---------------------------------------------------");

  await runTest("collects assistant text from message_end event", async () => {
    const msg = makeAssistantMessage("Hello from event");
    const events: AgentSessionEvent[] = [
      { type: "message_end", message: msg } as AgentSessionEvent,
    ];
    const { assistantTexts } = simulateEventCollection(events);
    if (assistantTexts.length !== 1)
      throw new Error(`Expected 1, got ${assistantTexts.length}`);
    if (assistantTexts[0] !== "Hello from event")
      throw new Error(`Wrong text: ${assistantTexts[0]}`);
  });

  await runTest("collects tool calls from message_end event", async () => {
    const tc = makeToolCall("web_search");
    const msg = makeAssistantMessage("", [tc]);
    const events: AgentSessionEvent[] = [
      { type: "message_end", message: msg } as AgentSessionEvent,
    ];
    const { toolCalls } = simulateEventCollection(events);
    if (toolCalls.length !== 1)
      throw new Error(`Expected 1, got ${toolCalls.length}`);
    if (toolCalls[0].name !== "web_search")
      throw new Error(`Wrong name: ${toolCalls[0].name}`);
  });

  await runTest("collects multiple assistant turns", async () => {
    const msg1 = makeAssistantMessage("Tool call response", [
      makeToolCall("read"),
    ]);
    const msg2 = makeAssistantMessage("Final answer");
    const events: AgentSessionEvent[] = [
      { type: "message_end", message: msg1 } as AgentSessionEvent,
      { type: "message_end", message: msg2 } as AgentSessionEvent,
    ];
    const { assistantTexts, toolCalls } = simulateEventCollection(events);
    if (assistantTexts.length !== 2)
      throw new Error(`Expected 2 texts, got ${assistantTexts.length}`);
    if (assistantTexts[1] !== "Final answer")
      throw new Error(`Wrong last text: ${assistantTexts[1]}`);
    if (toolCalls.length !== 1)
      throw new Error(`Expected 1 tool call, got ${toolCalls.length}`);
  });

  await runTest("skips non-assistant message_end events", async () => {
    const userMsg = makeUserMessage("Hello");
    const events: AgentSessionEvent[] = [
      { type: "message_end", message: userMsg } as AgentSessionEvent,
    ];
    const { assistantTexts } = simulateEventCollection(events);
    if (assistantTexts.length !== 0)
      throw new Error(`Expected 0, got ${assistantTexts.length}`);
  });

  await runTest("skips empty assistant text", async () => {
    const msg = makeAssistantMessage("", [makeToolCall("exec")]);
    const events: AgentSessionEvent[] = [
      { type: "message_end", message: msg } as AgentSessionEvent,
    ];
    const { assistantTexts, toolCalls } = simulateEventCollection(events);
    if (assistantTexts.length !== 0)
      throw new Error(`Expected 0 texts, got ${assistantTexts.length}`);
    if (toolCalls.length !== 1)
      throw new Error(`Expected 1 tool call, got ${toolCalls.length}`);
  });

  await runTest("tracks compaction via auto_compaction_end", async () => {
    const events: AgentSessionEvent[] = [
      {
        type: "auto_compaction_start",
        reason: "threshold",
      } as AgentSessionEvent,
      {
        type: "auto_compaction_end",
        result: undefined,
        aborted: false,
        willRetry: false,
      } as AgentSessionEvent,
    ];
    const { didCompact } = simulateEventCollection(events);
    if (!didCompact) throw new Error("Expected didCompact = true");
  });

  await runTest(
    "didCompact stays false without compaction events",
    async () => {
      const msg = makeAssistantMessage("No compaction");
      const events: AgentSessionEvent[] = [
        { type: "message_end", message: msg } as AgentSessionEvent,
      ];
      const { didCompact } = simulateEventCollection(events);
      if (didCompact) throw new Error("Expected didCompact = false");
    },
  );

  // ─── 3. Simulated compaction scenario (the actual bug) ───
  console.log("\n3. Compaction Scenario (the bug fix)");
  console.log("---------------------------------------------------");

  await runTest(
    "OLD: slice-based extraction fails after compaction",
    async () => {
      // Simulate: 765 messages before prompt, compaction reduces to 50 + 1 new
      const messageCountBefore = 765;
      const postCompactionMessages: Message[] = [];
      // After compaction, session.messages has ~50 compacted + 1 user + 1 assistant
      for (let i = 0; i < 50; i++) {
        postCompactionMessages.push(makeAssistantMessage(`compacted-${i}`));
      }
      postCompactionMessages.push(makeUserMessage("give me a project update"));
      postCompactionMessages.push(
        makeAssistantMessage("Here are the bullet points..."),
      );

      // OLD approach: slice(765) on a 52-element array → []
      const sliced = postCompactionMessages.slice(messageCountBefore);
      const oldResult = extractAssistantText(sliced);

      if (sliced.length !== 0)
        throw new Error(`Expected empty slice, got ${sliced.length}`);
      if (oldResult !== "")
        throw new Error(
          `Expected empty string from old approach, got "${oldResult}"`,
        );
    },
  );

  await runTest(
    "NEW: event-driven extraction works after compaction",
    async () => {
      // The model DID produce a response — message_end fired with the assistant message
      const assistantMsg = makeAssistantMessage(
        "Here are the bullet points...",
      );
      const events: AgentSessionEvent[] = [
        {
          type: "auto_compaction_start",
          reason: "threshold",
        } as AgentSessionEvent,
        {
          type: "auto_compaction_end",
          result: undefined,
          aborted: false,
          willRetry: false,
        } as AgentSessionEvent,
        { type: "message_end", message: assistantMsg } as AgentSessionEvent,
      ];

      const { assistantTexts, didCompact } = simulateEventCollection(events);
      const assistantContent = sanitizeAssistantOutput(
        assistantTexts[assistantTexts.length - 1] ?? "",
      );

      if (!didCompact) throw new Error("Expected didCompact = true");
      if (assistantContent !== "Here are the bullet points...")
        throw new Error(`Expected response text, got "${assistantContent}"`);
    },
  );

  await runTest("NEW: event collection + thinking tag stripping", async () => {
    const assistantMsg = makeAssistantMessage(
      "<think>Let me think about the project status...</think>Here are the key updates:\n- Feature A shipped\n- Bug B fixed",
    );
    const events: AgentSessionEvent[] = [
      {
        type: "auto_compaction_start",
        reason: "threshold",
      } as AgentSessionEvent,
      {
        type: "auto_compaction_end",
        result: undefined,
        aborted: false,
        willRetry: false,
      } as AgentSessionEvent,
      { type: "message_end", message: assistantMsg } as AgentSessionEvent,
    ];

    const { assistantTexts } = simulateEventCollection(events);
    const assistantContent = sanitizeAssistantOutput(
      assistantTexts[assistantTexts.length - 1] ?? "",
    );

    if (!assistantContent.includes("Feature A shipped"))
      throw new Error(
        `Expected content with bullet points, got "${assistantContent}"`,
      );
    if (assistantContent.includes("<think>"))
      throw new Error("Thinking tags should be stripped");
  });

  // ─── 4. DB save: compaction-aware tail extraction ───
  console.log("\n4. DB Save Path (compaction-aware)");
  console.log("---------------------------------------------------");

  await runTest("non-compaction: slice(messageCountBefore) works", async () => {
    const messageCountBefore = 3;
    const sessionMessages: Message[] = [
      makeUserMessage("msg1"),
      makeAssistantMessage("resp1"),
      makeUserMessage("msg2"),
      // new messages from this turn:
      makeAssistantMessage("resp2"),
    ];

    const newAgentMessages = filterToMessages(
      sessionMessages
        .slice(messageCountBefore)
        .filter((m) => m.role !== "user"),
    );
    if (newAgentMessages.length !== 1)
      throw new Error(`Expected 1, got ${newAgentMessages.length}`);
    if ((newAgentMessages[0] as AssistantMessage).content[0].type !== "text")
      throw new Error("Expected text content");
  });

  await runTest(
    "compaction: tail extraction finds new assistant messages",
    async () => {
      // After compaction, session.messages has compacted history + current turn
      const sessionMessages: Message[] = [
        makeAssistantMessage("compacted summary"),
        makeUserMessage("give me an update"),
        makeAssistantMessage("Here is the update"),
      ];

      // Compaction path: find last user, take everything after
      let lastUserIdx = -1;
      for (let i = sessionMessages.length - 1; i >= 0; i--) {
        if (sessionMessages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const newAgentMessages = filterToMessages(
        (lastUserIdx >= 0 ? sessionMessages.slice(lastUserIdx + 1) : []).filter(
          (m) => m.role !== "user",
        ),
      );

      if (newAgentMessages.length !== 1)
        throw new Error(`Expected 1, got ${newAgentMessages.length}`);
      const text = extractAssistantText(newAgentMessages);
      if (text !== "Here is the update")
        throw new Error(`Wrong text: "${text}"`);
    },
  );

  await runTest(
    "compaction: handles multi-turn tool use after compaction",
    async () => {
      const sessionMessages: Message[] = [
        makeAssistantMessage("compacted summary"),
        makeUserMessage("search for X"),
        makeAssistantMessage("Let me search", [makeToolCall("web_search")]),
        {
          role: "toolResult",
          toolCallId: "call_web_search_123",
          content: "search results",
        } as unknown as Message,
        makeAssistantMessage("Based on the search results..."),
      ];

      let lastUserIdx = -1;
      for (let i = sessionMessages.length - 1; i >= 0; i--) {
        if (sessionMessages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const newAgentMessages = filterToMessages(
        (lastUserIdx >= 0 ? sessionMessages.slice(lastUserIdx + 1) : []).filter(
          (m) => m.role !== "user",
        ),
      );

      // Should include the tool-calling assistant msg, toolResult, and final assistant msg
      if (newAgentMessages.length < 2)
        throw new Error(`Expected >=2, got ${newAgentMessages.length}`);
    },
  );

  // ─── Summary ───
  console.log("\n===================================================");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `  Results: ${passed} passed, ${failed} failed, ${results.length} total`,
  );
  console.log("===================================================\n");

  if (failed > 0) {
    console.log("FAILED tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
