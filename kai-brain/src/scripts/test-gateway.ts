/**
 * Gateway Test Script
 *
 * Tests WebSocket gateway, queue, cron, and browser functionality.
 */
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

const GATEWAY_URL = "ws://localhost:18789/ws";

interface RpcResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string };
}

interface RpcEvent {
  type: "event";
  event: string;
  payload: unknown;
}

async function sendRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const id = uuidv4();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 30000);

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as RpcResponse | RpcEvent;
        if ("type" in msg && msg.type === "res" && msg.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (!msg.ok) {
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              reject(new Error("Unknown gateway error"));
            }
          } else {
            resolve(msg.payload);
          }
        }
      } catch {
        // Ignore parse errors for events
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function performHandshake(ws: WebSocket): Promise<void> {
  const challenge = await new Promise<{ nonce: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connect.challenge timeout")), 5000);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as RpcEvent;
        if (msg.type === "event" && msg.event === "connect.challenge") {
          clearTimeout(timeout);
          ws.off("message", handler);
          const nonce =
            msg.payload &&
            typeof msg.payload === "object" &&
            typeof (msg.payload as { nonce?: unknown }).nonce === "string"
              ? (msg.payload as { nonce: string }).nonce
              : "";
          if (!nonce) {
            reject(new Error("connect.challenge missing nonce"));
            return;
          }
          resolve({ nonce });
        }
      } catch {
        // Ignore non-event payloads.
      }
    };
    ws.on("message", handler);
  });

  await sendRpc(ws, "connect", {
    nonce: challenge.nonce,
    client: {
      id: "gateway-test-script",
      name: "gateway-test-script",
      version: "1",
      platform: "node",
    },
    caps: ["chat.send", "chat.history"],
  });
}

async function connectWebSocket(): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(GATEWAY_URL);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
  await performHandshake(ws);
  return ws;
}

function test(name: string, fn: () => Promise<void>): () => Promise<boolean> {
  return async () => {
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      console.log("✓");
      return true;
    } catch (error) {
      console.log(
        `✗ ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  };
}

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("               AVA Gateway Test Suite                       ");
  console.log("═══════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;

  // Connect to gateway
  console.log("1. WebSocket Connection");
  console.log("───────────────────────────────────────────────────────────");

  process.stdout.write("  Connect to gateway... ");
  const ws = await connectWebSocket();
  if (ws.readyState !== WebSocket.OPEN) {
    console.log("✗ WebSocket not open");
    process.exit(1);
  }
  console.log("✓");
  passed++;

  // Session tests
  console.log("\n2. Sessions API");
  console.log("───────────────────────────────────────────────────────────");

  let testSessionKey: string | undefined;

  if (
    await test("sessions.list", async () => {
      const result = (await sendRpc(ws, "sessions.list", { limit: 5 })) as {
        sessions: Array<{ sessionKey: string }>;
        total: number;
      };
      if (!Array.isArray(result.sessions)) {
        throw new Error("Expected sessions array");
      }
      if (result.sessions.length > 0) {
        testSessionKey = result.sessions[0].sessionKey;
      }
    })()
  ) {
    passed++;
  } else {
    failed++;
  }

  if (
    await test("sessions.preview", async () => {
      const result = (await sendRpc(ws, "sessions.preview", { limit: 5 })) as {
        previews: unknown[];
      };
      if (!Array.isArray(result.previews)) {
        throw new Error("Expected previews array");
      }
    })()
  ) {
    passed++;
  } else {
    failed++;
  }

  // Queue tests
  console.log("\n3. Queue API");
  console.log("───────────────────────────────────────────────────────────");

  if (
    await test("queue.stats", async () => {
      const result = (await sendRpc(ws, "queue.stats", {})) as {
        pending: number;
        processing: number;
      };
      if (typeof result.pending !== "number") {
        throw new Error("Expected pending count");
      }
    })()
  ) {
    passed++;
  } else {
    failed++;
  }

  // Cron tests
  console.log("\n4. Cron API");
  console.log("───────────────────────────────────────────────────────────");

  if (
    await test("cron.list", async () => {
      const result = (await sendRpc(ws, "cron.list", {})) as {
        jobs: unknown[];
      };
      if (!Array.isArray(result.jobs)) {
        throw new Error("Expected jobs array");
      }
    })()
  ) {
    passed++;
  } else {
    failed++;
  }

  // Browser tests
  console.log("\n5. Browser API");
  console.log("───────────────────────────────────────────────────────────");

  if (
    await test("browser.status", async () => {
      const result = (await sendRpc(ws, "browser.status", {})) as {
        running: boolean;
      };
      if (typeof result.running !== "boolean") {
        throw new Error("Expected running boolean");
      }
    })()
  ) {
    passed++;
  } else {
    failed++;
  }

  // Chat run test (only if we have a session)
  console.log("\n6. Chat API");
  console.log("───────────────────────────────────────────────────────────");

  if (testSessionKey) {
    if (
      await test("chat.send + chat.history", async () => {
        const result = (await sendRpc(ws, "chat.send", {
          sessionKey: testSessionKey,
          message: "What time is it?",
          idempotencyKey: `script-${uuidv4()}`,
        })) as { runId: string; status: string };

        if (!result.runId) {
          throw new Error("Expected runId");
        }
        if (result.status !== "started" && result.status !== "in_flight") {
          throw new Error(`Unexpected status ${result.status}`);
        }

        await new Promise((r) => setTimeout(r, 2000));
        const history = (await sendRpc(ws, "chat.history", {
          sessionKey: testSessionKey,
          limit: 20,
        })) as { messages: unknown[] };
        if (!Array.isArray(history.messages)) {
          throw new Error("Expected chat history messages");
        }
      })()
    ) {
      passed++;
    } else {
      failed++;
    }
  } else {
    console.log("  Skipping chat.send (no session available)");
  }

  // Cleanup
  ws.close();

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                        SUMMARY                            ");
  console.log("═══════════════════════════════════════════════════════════\n");

  const total = passed + failed;
  console.log(`  Total: ${total} tests`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);

  if (failed === 0) {
    console.log("\n  All tests passed! ✓\n");
    process.exit(0);
  } else {
    console.log("\n  Some tests failed! ✗\n");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test suite failed:", error);
  process.exit(1);
});
