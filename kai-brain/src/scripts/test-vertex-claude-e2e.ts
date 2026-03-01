/**
 * End-to-end test: Claude on Vertex AI via pi-agent
 *
 * Tests:
 * 1. Model routing (Claude → vertex-claude-api, Gemini → google-vertex)
 * 2. Live streaming call to Claude Opus 4.6 on Vertex AI
 * 3. Tool calling works (simple tool round-trip)
 * 4. Gemini fallback model still works
 */
import dotenv from "dotenv";
dotenv.config();

import {
  getPiModel,
  isAnthropicModel,
  getDefaultModelId,
  getDefaultProvider,
} from "../agent/pi-provider.js";
import { stream, type Model, type Context, Type } from "@mariozechner/pi-ai";

const PASS = "✓";
const FAIL = "✗";
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// --- Test 1: Model routing ---
function testModelRouting() {
  console.log("\n[1] Model routing");

  assert("Default model is claude-opus-4-6", getDefaultModelId() === "claude-opus-4-6");
  assert("Default provider is vertex", getDefaultProvider() === "vertex");
  assert("isAnthropicModel('claude-opus-4-6') = true", isAnthropicModel("claude-opus-4-6"));
  assert("isAnthropicModel('gemini-2.5-pro') = false", !isAnthropicModel("gemini-2.5-pro"));

  const claudeModel = getPiModel("vertex", "claude-opus-4-6");
  assert("Claude model api = vertex-claude-api", claudeModel.api === "vertex-claude-api");
  assert("Claude model provider = google-vertex-claude", claudeModel.provider === "google-vertex-claude");
  assert("Claude model contextWindow = 200000", claudeModel.contextWindow === 200_000);

  const geminiModel = getPiModel("vertex", "gemini-2.5-pro");
  assert("Gemini model api = google-vertex", geminiModel.api === "google-vertex");
  assert("Gemini model provider = google-vertex", geminiModel.provider === "google-vertex");
}

// --- Test 2: Live Claude streaming ---
async function testClaudeStreaming() {
  console.log("\n[2] Claude Opus 4.6 streaming (live Vertex AI call)");

  const model = getPiModel("vertex", "claude-opus-4-6");
  const context: Context = {
    systemPrompt: "You are a helpful assistant. Be very brief.",
    messages: [
      { role: "user", content: "What is 2+2? Answer with just the number.", timestamp: Date.now() },
    ],
  };

  const start = Date.now();
  let fullText = "";
  let gotStart = false;
  let gotDone = false;
  let usage = { input: 0, output: 0 };

  try {
    const eventStream = stream(model as Model<any>, context, {});

    for await (const event of eventStream) {
      if (event.type === "start") gotStart = true;
      if (event.type === "text_delta") fullText += event.delta;
      if (event.type === "done") {
        gotDone = true;
        usage = { input: event.message.usage.input, output: event.message.usage.output };
      }
    }

    const elapsed = Date.now() - start;
    assert("Got start event", gotStart);
    assert("Got done event", gotDone);
    assert("Response is non-empty", fullText.trim().length > 0, `got: "${fullText.trim()}"`);
    assert("Response contains '4'", fullText.includes("4"), `got: "${fullText.trim()}"`);
    assert("Input tokens > 0", usage.input > 0, `input=${usage.input}`);
    assert("Output tokens > 0", usage.output > 0, `output=${usage.output}`);
    console.log(`  (${elapsed}ms, ${usage.input}in/${usage.output}out tokens)`);
  } catch (error: any) {
    assert("Streaming call succeeded", false, error.message);
  }
}

// --- Test 3: Tool calling ---
async function testToolCalling() {
  console.log("\n[3] Claude tool calling (live Vertex AI call)");

  const model = getPiModel("vertex", "claude-opus-4-6");
  const tools = [
    {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: Type.Object({
        city: Type.String({ description: "City name" }),
      }),
    },
  ];

  const context: Context = {
    systemPrompt: "You are a helpful assistant. Use the get_weather tool when asked about weather.",
    messages: [
      { role: "user", content: "What's the weather in Tokyo?", timestamp: Date.now() },
    ],
    tools,
  };

  const start = Date.now();
  let gotToolCall = false;
  let toolName = "";
  let toolArgs: any = {};

  try {
    const eventStream = stream(model as Model<any>, context, {});

    for await (const event of eventStream) {
      if (event.type === "toolcall_end") {
        gotToolCall = true;
        toolName = event.toolCall.name;
        toolArgs = event.toolCall.arguments;
      }
    }

    const elapsed = Date.now() - start;
    assert("Got tool call", gotToolCall);
    assert("Tool name is get_weather", toolName === "get_weather", `got: "${toolName}"`);
    assert("Tool args has city", typeof toolArgs.city === "string" && toolArgs.city.length > 0, `got: ${JSON.stringify(toolArgs)}`);
    console.log(`  (${elapsed}ms, tool: ${toolName}(${JSON.stringify(toolArgs)}))`);
  } catch (error: any) {
    assert("Tool calling succeeded", false, error.message);
  }
}

// --- Test 4: Gemini still works ---
async function testGeminiFallback() {
  console.log("\n[4] Gemini 2.5 Pro fallback (live Vertex AI call)");

  const model = getPiModel("vertex", "gemini-2.5-pro");
  const context: Context = {
    systemPrompt: "Be very brief.",
    messages: [
      { role: "user", content: "Say hello in one word.", timestamp: Date.now() },
    ],
  };

  const start = Date.now();
  let fullText = "";
  let gotDone = false;

  try {
    const eventStream = stream(model as Model<any>, context, {});

    for await (const event of eventStream) {
      if (event.type === "text_delta") fullText += event.delta;
      if (event.type === "done") gotDone = true;
    }

    const elapsed = Date.now() - start;
    assert("Got done event", gotDone);
    assert("Response is non-empty", fullText.trim().length > 0, `got: "${fullText.trim()}"`);
    console.log(`  (${elapsed}ms, response: "${fullText.trim().slice(0, 50)}")`);
  } catch (error: any) {
    assert("Gemini call succeeded", false, error.message);
  }
}

// --- Run all ---
async function main() {
  console.log("=== Vertex AI Claude E2E Test ===");

  testModelRouting();
  await testClaudeStreaming();
  await testToolCalling();
  await testGeminiFallback();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
