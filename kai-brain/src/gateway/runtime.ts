/**
 * Gateway Runtime
 *
 * Manages WebSocket connections, subscriptions, and event broadcasting.
 */
import type { WebSocket } from "ws";
import type { ResponseFrame, EventFrame } from "./protocol/types.js";
import type { GatewayEvent } from "./protocol/events.js";
import { v4 as uuidv4 } from "uuid";
import type { AuthContext } from "../lib/auth/jwt.js";
import { createLogger } from "../lib/logger.js";
import { getConfig } from "../lib/config-loader.js";

const log = createLogger("gateway", { component: "runtime" });

const MAX_BUFFERED_BYTES = Math.max(64_000, Math.floor(getConfig().gateway.maxBufferedBytes));

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  auth?: AuthContext;
  subscriptions: Set<string>;
  sessionSubscriptions: Set<string>;
  connectedAt: number;
  handshakeComplete: boolean;
  caps: Set<string>;
  clientMeta?: {
    id?: string;
    name?: string;
    version?: string;
    platform?: string;
  };
}

export interface AgentRun {
  runId: string;
  sessionId: string;
  userId: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled";
  startedAt: number;
  completedAt?: number;
  content?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  abortController?: AbortController;
}

export interface BroadcastOptions {
  dropIfSlow?: boolean;
  includeClientIds?: string[];
  stateVersion?: Record<string, number>;
}

class GatewayRuntime {
  private clients = new Map<string, ClientConnection>();
  private runs = new Map<string, AgentRun>();
  private globalEventSeq = 0;

  // Run cleanup after 10 minutes
  private readonly RUN_TTL_MS = 10 * 60 * 1000;

  addClient(ws: WebSocket, auth?: AuthContext): ClientConnection {
    const client: ClientConnection = {
      id: uuidv4(),
      ws,
      auth,
      subscriptions: new Set(),
      sessionSubscriptions: new Set(),
      connectedAt: Date.now(),
      handshakeComplete: false,
      caps: new Set(),
    };
    this.clients.set(client.id, client);
    log.info(
      { clientId: client.id, userId: client.auth?.userId ?? null },
      "Gateway client connected",
    );
    return client;
  }

  markClientConnected(
    clientId: string,
    params?: {
      caps?: string[];
      clientMeta?: ClientConnection["clientMeta"];
    },
  ): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.handshakeComplete = true;
    client.caps = new Set(
      (params?.caps ?? []).filter((entry) => typeof entry === "string" && entry.trim().length > 0),
    );
    if (params?.clientMeta) {
      client.clientMeta = params.clientMeta;
    }
    return true;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    log.info({ clientId }, "Gateway client disconnected");
  }

  getClient(clientId: string): ClientConnection | undefined {
    return this.clients.get(clientId);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Returns true when another connected client (excluding `excludeClientId`)
   * is currently subscribed to the given session.
   */
  hasOtherSessionSubscribers(sessionId: string, excludeClientId?: string): boolean {
    for (const client of this.clients.values()) {
      if (excludeClientId && client.id === excludeClientId) {
        continue;
      }
      if (client.ws.readyState !== 1) {
        continue;
      }
      if (client.sessionSubscriptions.has(sessionId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true when at least one connected client is subscribed
   * to the provided session.
   */
  hasSessionSubscribers(sessionId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== 1) {
        continue;
      }
      if (client.sessionSubscriptions.has(sessionId)) {
        return true;
      }
    }
    return false;
  }

  subscribe(clientId: string, events: string[], sessionId?: string): string[] {
    const client = this.clients.get(clientId);
    if (!client) return [];

    const subscribed: string[] = [];
    for (const event of events) {
      client.subscriptions.add(event);
      subscribed.push(event);
    }

    if (sessionId) {
      client.sessionSubscriptions.add(sessionId);
    }

    return subscribed;
  }

  unsubscribe(clientId: string, events: string[]): string[] {
    const client = this.clients.get(clientId);
    if (!client) return [];

    const unsubscribed: string[] = [];
    for (const event of events) {
      if (client.subscriptions.delete(event)) {
        unsubscribed.push(event);
      }
    }

    // Session-scoped subscriptions are only meaningful while at least one
    // event subscription remains active for this client.
    if (client.subscriptions.size === 0) {
      client.sessionSubscriptions.clear();
    }

    return unsubscribed;
  }

  private matchesSubscription(client: ClientConnection, eventType: string): boolean {
    return (
      client.subscriptions.has(eventType) ||
      client.subscriptions.has("*") ||
      client.subscriptions.has(`${eventType.split(".")[0]}.*`)
    );
  }

  private sendFrameToClient(
    client: ClientConnection,
    payload: string,
    opts?: { dropIfSlow?: boolean },
  ): void {
    if (client.ws.readyState !== 1) {
      return;
    }

    const slowConsumer = client.ws.bufferedAmount > MAX_BUFFERED_BYTES;
    if (slowConsumer && opts?.dropIfSlow) {
      return;
    }
    if (slowConsumer) {
      try {
        client.ws.close(1008, "slow consumer");
      } catch {
        // Ignore close failures.
      }
      return;
    }

    client.ws.send(payload, (error) => {
      if (error) {
        log.warn(
          { clientId: client.id, err: error },
          "Failed to send message to client",
        );
      }
    });
  }

  broadcast(event: GatewayEvent, sessionId?: string, opts?: BroadcastOptions): void {
    const eventType = event.event;
    const includeClientIds = new Set(opts?.includeClientIds ?? []);
    const targeted = Boolean(sessionId) || includeClientIds.size > 0;
    const frame: EventFrame = {
      type: "event",
      event: eventType,
      payload: event.payload,
      ...(targeted ? {} : { seq: ++this.globalEventSeq }),
      ...(opts?.stateVersion ? { stateVersion: opts.stateVersion } : {}),
    };
    const serialized = JSON.stringify(frame);

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== 1) continue;

      const explicitMatch = includeClientIds.has(client.id);
      const subscribedMatch =
        this.matchesSubscription(client, eventType) &&
        (!sessionId || client.sessionSubscriptions.has(sessionId));

      if (!explicitMatch && !subscribedMatch) {
        continue;
      }

      this.sendFrameToClient(client, serialized, {
        dropIfSlow: opts?.dropIfSlow,
      });
    }
  }

  sendEventToClient(
    clientId: string,
    event: string,
    payload?: unknown,
    opts?: {
      includeSeq?: boolean;
      stateVersion?: Record<string, number>;
      dropIfSlow?: boolean;
    },
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const frame: EventFrame = {
      type: "event",
      event,
      ...(typeof payload === "undefined" ? {} : { payload }),
      ...(opts?.includeSeq ? { seq: ++this.globalEventSeq } : {}),
      ...(opts?.stateVersion ? { stateVersion: opts.stateVersion } : {}),
    };
    this.sendFrameToClient(client, JSON.stringify(frame), {
      dropIfSlow: opts?.dropIfSlow,
    });
  }

  sendEventToClients(
    clientIds: string[],
    event: string,
    payload?: unknown,
    opts?: {
      includeSeq?: boolean;
      stateVersion?: Record<string, number>;
      dropIfSlow?: boolean;
    },
  ): void {
    for (const clientId of clientIds) {
      this.sendEventToClient(clientId, event, payload, opts);
    }
  }

  getSessionClientIds(params: {
    sessionId: string;
    eventType?: string;
    requiredCaps?: string[];
  }): string[] {
    const targetSessionId = params.sessionId;
    const eventType = params.eventType;
    const requiredCaps = params.requiredCaps ?? [];
    const clientIds: string[] = [];

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== 1) {
        continue;
      }
      if (!client.sessionSubscriptions.has(targetSessionId)) {
        continue;
      }
      if (eventType && !this.matchesSubscription(client, eventType)) {
        continue;
      }
      if (requiredCaps.some((cap) => !client.caps.has(cap))) {
        continue;
      }
      clientIds.push(client.id);
    }

    return clientIds;
  }

  sendToClient(clientId: string, message: ResponseFrame | EventFrame): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.sendFrameToClient(client, JSON.stringify(message));
  }

  // Agent run management
  createRun(sessionId: string, userId: string, opts?: { runId?: string }): AgentRun {
    const run: AgentRun = {
      runId: opts?.runId?.trim() || uuidv4(),
      sessionId,
      userId,
      status: "pending",
      startedAt: Date.now(),
      abortController: new AbortController(),
    };
    this.runs.set(run.runId, run);

    // Schedule cleanup
    setTimeout(() => {
      this.runs.delete(run.runId);
    }, this.RUN_TTL_MS);

    return run;
  }

  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  updateRun(runId: string, updates: Partial<AgentRun>): void {
    const run = this.runs.get(runId);
    if (run) {
      Object.assign(run, updates);
    }
  }

  cancelRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    if (run.status === "pending" || run.status === "running") {
      run.abortController?.abort();
      run.status = "cancelled";
      run.completedAt = Date.now();
      return true;
    }
    return false;
  }

  cancelRunsForSession(sessionId: string): number {
    let cancelled = 0;
    const now = Date.now();
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) {
        continue;
      }
      if (run.status === "pending" || run.status === "running") {
        run.abortController?.abort();
        run.status = "cancelled";
        run.completedAt = now;
        cancelled += 1;
      }
    }
    return cancelled;
  }

  getRunsBySession(sessionId: string): AgentRun[] {
    return Array.from(this.runs.values()).filter((r) => r.sessionId === sessionId);
  }

  getActiveRunCount(): number {
    return Array.from(this.runs.values()).filter(
      (run) => run.status === "pending" || run.status === "running",
    ).length;
  }

  async waitForRunsIdle(opts?: {
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<boolean> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const pollMs = opts?.pollMs ?? 25;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.getActiveRunCount() === 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return false;
  }

  /**
   * Test-only reset for runtime state.
   */
  resetForTests(): void {
    this.clients.clear();
    this.runs.clear();
    this.globalEventSeq = 0;
  }
}

export const runtime = new GatewayRuntime();
