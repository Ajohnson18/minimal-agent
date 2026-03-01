function resolveWsUrl(): string {
  if (import.meta.env.VITE_KAI_BRAIN_WS_URL) {
    return import.meta.env.VITE_KAI_BRAIN_WS_URL;
  }
  if (typeof window !== "undefined" && window.location.hostname !== "localhost") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return "ws://localhost:18789/ws";
}

const WS_URL = resolveWsUrl();
const RECONNECT_DELAY_MS = 2000;

type Listener = (event: GatewayEvent) => void;
type RpcCallback = (response: RpcResponse) => void;
type ConnectionStateListener = (state: ConnectionState) => void;

export type ConnectionState = "disconnected" | "connecting" | "handshaking" | "connected";

export interface RpcResponse {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface GatewayEvent {
  event: string;
  payload: Record<string, unknown>;
}

let ws: WebSocket | null = null;
let msgId = 0;
let connectionState: ConnectionState = "disconnected";
let handshakeComplete = false;
let pendingConnectNonce: string | null = null;
const pending = new Map<string, RpcCallback>();
const listeners = new Set<Listener>();
const connectionStateListeners = new Set<ConnectionStateListener>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const deferredRpcs: Array<() => void> = [];

function setConnectionState(state: ConnectionState) {
  connectionState = state;
  connectionStateListeners.forEach((fn) => fn(state));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  handshakeComplete = false;
  pendingConnectNonce = null;
  setConnectionState("connecting");

  const token = localStorage.getItem("kai_token");
  const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;
  ws = new WebSocket(url);

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setConnectionState("handshaking");
  };

  ws.onmessage = (e) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }

    const frameType = data.type as string | undefined;

    // Response frame: { type: "res", id, ok, payload?, error? }
    if (frameType === "res" && typeof data.id === "string") {
      const cb = pending.get(data.id as string);
      if (cb) {
        pending.delete(data.id as string);
        cb({
          id: data.id as string,
          ok: data.ok as boolean,
          payload: data.payload,
          error: data.error as RpcResponse["error"],
        });
      }
      return;
    }

    // Event frame: { type: "event", event, payload }
    if (frameType === "event" && typeof data.event === "string") {
      const evt: GatewayEvent = {
        event: data.event as string,
        payload: (data.payload ?? {}) as Record<string, unknown>,
      };

      if (evt.event === "connect.challenge") {
        pendingConnectNonce = evt.payload.nonce as string;
        performHandshake();
        return;
      }

      listeners.forEach((fn) => fn(evt));
      return;
    }

    // Legacy compat: frames without `type` field
    if (!frameType) {
      if (typeof data.id === "string" && pending.has(data.id as string)) {
        const cb = pending.get(data.id as string)!;
        pending.delete(data.id as string);
        cb({
          id: data.id as string,
          ok: !data.error,
          payload: data.result,
          error: data.error as RpcResponse["error"],
        });
        return;
      }
      if (typeof data.event === "string") {
        const evt: GatewayEvent = {
          event: data.event as string,
          payload: (data.payload ?? {}) as Record<string, unknown>,
        };
        if (evt.event === "connect.challenge") {
          pendingConnectNonce = evt.payload.nonce as string;
          performHandshake();
          return;
        }
        listeners.forEach((fn) => fn(evt));
      }
    }
  };

  ws.onclose = () => {
    ws = null;
    handshakeComplete = false;
    pendingConnectNonce = null;
    setConnectionState("disconnected");
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => ws?.close();
}

function performHandshake() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !pendingConnectNonce) return;

  const id = String(++msgId);
  pending.set(id, (resp) => {
    if (resp.ok) {
      handshakeComplete = true;
      setConnectionState("connected");
      flushDeferredRpcs();
    } else {
      console.error("[gateway] handshake failed:", resp.error?.message);
      ws?.close();
    }
  });

  ws.send(JSON.stringify({
    type: "req",
    id,
    method: "connect",
    params: {
      nonce: pendingConnectNonce,
      caps: ["tool-events"],
      client: {
        name: "kai-face",
        platform: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 64) : "unknown",
      },
    },
  }));
}

function flushDeferredRpcs() {
  while (deferredRpcs.length > 0) {
    const fn = deferredRpcs.shift();
    fn?.();
  }
}

export function ensureConnected() {
  connect();
}

export function getConnectionState(): ConnectionState {
  return connectionState;
}

export function onConnectionStateChange(fn: ConnectionStateListener): () => void {
  connectionStateListeners.add(fn);
  return () => connectionStateListeners.delete(fn);
}

export function rpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    connect();
    const id = String(++msgId);
    pending.set(id, (resp) => {
      if (resp.error || !resp.ok) reject(new Error(resp.error?.message ?? "RPC failed"));
      else resolve(resp.payload as T);
    });

    const frame = JSON.stringify({ type: "req", id, method, params });

    const doSend = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    };

    if (handshakeComplete && ws?.readyState === WebSocket.OPEN) {
      doSend();
    } else {
      deferredRpcs.push(doSend);
    }
  });
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
