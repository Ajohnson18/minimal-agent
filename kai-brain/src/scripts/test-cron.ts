/**
 * Cron Service Test
 *
 * Tests that scheduled jobs fire correctly.
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
        const msg = JSON.parse(data.toString()) as RpcResponse;
        if ("type" in msg && msg.type === "res" && msg.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (!msg.ok) {
            reject(new Error(msg.error?.message ?? "Gateway error"));
          } else {
            resolve(msg.payload);
          }
        }
      } catch {
        // Ignore
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("               AVA Cron Service Test                         ");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Connect
  console.log("Connecting to gateway...");
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(GATEWAY_URL);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
  const challenge = await new Promise<{ nonce: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("connect.challenge timeout")), 5000);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          event?: string;
          payload?: { nonce?: string };
        };
        if (msg.type === "event" && msg.event === "connect.challenge") {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (!msg.payload?.nonce) {
            reject(new Error("connect.challenge missing nonce"));
            return;
          }
          resolve({ nonce: msg.payload.nonce });
        }
      } catch {
        // Ignore.
      }
    };
    ws.on("message", handler);
  });
  await sendRpc(ws, "connect", {
    nonce: challenge.nonce,
    client: {
      id: "cron-test-script",
      name: "cron-test-script",
      version: "1",
      platform: "node",
    },
    caps: ["chat.send"],
  });
  console.log("Connected ✓\n");

  // Get or create a test session
  const sessionsResult = (await sendRpc(ws, "sessions.list", { limit: 1 })) as {
    sessions: Array<{ sessionKey: string }>;
  };

  let sessionKey: string;
  if (sessionsResult.sessions.length > 0) {
    sessionKey = sessionsResult.sessions[0].sessionKey;
    console.log(`Using existing session: ${sessionKey}`);
  } else {
    console.log("No sessions found. Creating test scenario...");
    process.exit(1);
  }

  // Calculate time 15 seconds from now in UTC
  const now = new Date();
  const fireAt = new Date(now.getTime() + 15000); // 15 seconds from now
  const scheduleValue = fireAt.toISOString();

  console.log(`\nCurrent time (UTC): ${now.toISOString()}`);
  console.log(`Scheduling job for: ${scheduleValue}`);
  console.log("(15 seconds from now)\n");

  // Create a scheduled job
  const addResult = (await sendRpc(ws, "cron.add", {
    sessionKey,
    userId: "test-cron-user",
    name: "Test Reminder",
    scheduleKind: "at",
    scheduleValue,
    payload: "This is a test reminder that should fire in 15 seconds!",
    deleteAfterRun: true,
  })) as { job: { id: string; nextRunAt: string } };

  console.log(`Created job: ${addResult.job.id}`);
  console.log(`Next run at: ${addResult.job.nextRunAt}`);

  // Subscribe to session events
  await sendRpc(ws, "subscribe", {
    events: ["cron.fired", "agent.started", "agent.completed"],
    sessionKey,
  });
  console.log(
    "\nSubscribed to session events. Waiting for cron.fired event..."
  );

  // Listen for events
  let cronFired = false;
  const startTime = Date.now();

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "cron.fired") {
        console.log("\n✓ CRON JOB FIRED!");
        console.log(`  Job ID: ${msg.payload.jobId}`);
        console.log(`  Session Key: ${msg.payload.sessionKey}`);
        console.log(
          `  Fired at: ${new Date(msg.payload.firedAt).toISOString()}`
        );
        cronFired = true;
      }
      if (msg.event === "agent.started") {
        console.log("\n✓ Agent execution started from cron trigger!");
      }
      if (msg.event === "agent.completed") {
        console.log("✓ Agent execution completed!");
        console.log(`  Response: ${msg.payload.response?.slice(0, 100)}...`);
      }
    } catch {
      // Ignore parse errors
    }
  });

  // Wait up to 30 seconds
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      if (cronFired) {
        clearInterval(checkInterval);
        setTimeout(resolve, 2000); // Wait a bit more for agent response
      } else if (elapsed > 30) {
        console.log("\n✗ Timeout waiting for cron job to fire");
        clearInterval(checkInterval);
        resolve();
      } else {
        process.stdout.write(`\r  Waiting... ${elapsed.toFixed(0)}s elapsed`);
      }
    }, 500);
  });

  console.log("\n");
  ws.close();

  if (cronFired) {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("                    TEST PASSED ✓                          ");
    console.log(
      "═══════════════════════════════════════════════════════════\n"
    );
    process.exit(0);
  } else {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("                    TEST FAILED ✗                          ");
    console.log(
      "═══════════════════════════════════════════════════════════\n"
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
