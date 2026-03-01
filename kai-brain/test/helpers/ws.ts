import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

type WsResponsePayload<T> = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: T;
  error?: { code: number; message: string };
};

type WsEventPayload = {
  type: "event";
  event: string;
  payload?: unknown;
};

async function performConnectHandshake(
  ws: WebSocket,
  opts?: {
    initialNonce?: string | null;
    caps?: string[];
  },
): Promise<void> {
  let nonce = opts?.initialNonce?.trim() ?? "";
  if (!nonce) {
    const challenge = await new Promise<WsEventPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("Timed out waiting for connect.challenge"));
      }, 3_000);

      const onMessage = (data: Buffer) => {
        try {
          const payload = JSON.parse(data.toString()) as WsEventPayload;
          if (payload.type === "event" && payload.event === "connect.challenge") {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve(payload);
          }
        } catch {
          // Ignore unrelated frames.
        }
      };

      ws.on("message", onMessage);
    });

    nonce =
      challenge.payload &&
      typeof challenge.payload === "object" &&
      typeof (challenge.payload as { nonce?: unknown }).nonce === "string"
        ? (challenge.payload as { nonce: string }).nonce
        : "";
  }
  if (!nonce) {
    throw new Error("connect.challenge payload missing nonce");
  }

  const response = await rpcCall<{ connected: boolean }>(ws, "connect", {
    nonce,
    client: {
      id: "vitest",
      name: "vitest",
      version: "1",
      platform: "test",
    },
    caps: opts?.caps && opts.caps.length > 0
      ? opts.caps
      : ["chat.history", "chat.send"],
  });

  if (response.error) {
    throw new Error(`connect failed: ${response.error.message}`);
  }
  if (!response.result?.connected) {
    throw new Error("connect response missing connected=true");
  }
}

export async function openWebSocket(
  url: string,
  options?: {
    token?: string;
    skipConnectHandshake?: boolean;
    caps?: string[];
  },
): Promise<WebSocket> {
  let earlyChallengeNonce: string | null = null;
  let captureChallenge: ((data: Buffer) => void) | null = null;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const headers =
      options?.token && options.token.length > 0
        ? { Authorization: `Bearer ${options.token}` }
        : undefined;
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    captureChallenge = (data: Buffer) => {
      try {
        const payload = JSON.parse(data.toString()) as WsEventPayload;
        if (
          payload.type === "event" &&
          payload.event === "connect.challenge" &&
          payload.payload &&
          typeof payload.payload === "object" &&
          typeof (payload.payload as { nonce?: unknown }).nonce === "string"
        ) {
          earlyChallengeNonce = (payload.payload as { nonce: string }).nonce;
        }
      } catch {
        // Ignore unrelated frames.
      }
    };
    socket.on("message", captureChallenge);
    socket.once("open", () => resolve(socket));
    socket.once("error", (error) => reject(error));
  });

  if (!options?.skipConnectHandshake) {
    await performConnectHandshake(ws, {
      initialNonce: earlyChallengeNonce,
      caps: options?.caps,
    });
  }
  if (captureChallenge) {
    ws.off("message", captureChallenge);
  }

  return ws;
}

export async function rpcCall<T = unknown>(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ id: string; result?: T; error?: { code: number; message: string } }> {
  const id = randomUUID();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`RPC timeout for ${method}`));
    }, 10_000);

    const onMessage = (data: Buffer) => {
      try {
        const payload = JSON.parse(data.toString()) as WsResponsePayload<T> | WsEventPayload;
        if (payload.type !== "res") {
          return;
        }
        if (payload.id !== id) {
          return;
        }
        clearTimeout(timeout);
        ws.off("message", onMessage);
        if (!payload.ok) {
          resolve({
            id,
            error: payload.error
              ? { code: payload.error.code, message: payload.error.message }
              : { code: -32603, message: "Unknown RPC error" },
          });
          return;
        }
        resolve({ id, result: payload.payload as T });
      } catch (error) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        reject(error);
      }
    };

    ws.on("message", onMessage);
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );
  });
}

export async function closeWebSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}
