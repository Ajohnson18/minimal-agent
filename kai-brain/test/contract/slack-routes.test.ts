import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const handleSlackMessageMock = vi.fn();
const storePendingMessageMock = vi.fn();
const injectSystemEventMock = vi.fn();
const resolveExecApprovalDecisionBySlackUserMock = vi.fn();
const { resolveThreadDispatchStateMock } = vi.hoisted(() => ({
  resolveThreadDispatchStateMock: vi.fn(),
}));

vi.mock("../../src/slack/monitor/runtime.js", () => ({
  handleSlackMessage: handleSlackMessageMock,
  storePendingMessage: storePendingMessageMock,
  injectSystemEvent: injectSystemEventMock,
  enqueueSlackMessage: vi.fn(),
  resolveThreadDispatchState: resolveThreadDispatchStateMock,
}));

vi.mock("../../src/services/exec-approval.service.js", () => ({
  EXEC_APPROVAL_ACTION_ID: "exec_approval_decision",
  decodeExecApprovalActionValue: (raw: unknown) => {
    if (typeof raw !== "string") {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        approvalId?: string;
        decision?: "allow-once" | "allow-always" | "deny";
      };
      if (
        !parsed.approvalId ||
        (parsed.decision !== "allow-once" &&
          parsed.decision !== "allow-always" &&
          parsed.decision !== "deny")
      ) {
        return null;
      }
      return {
        approvalId: parsed.approvalId,
        decision: parsed.decision,
      };
    } catch {
      return null;
    }
  },
  resolveExecApprovalDecisionBySlackUser: resolveExecApprovalDecisionBySlackUserMock,
}));

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { closeHttpServer, startHttpServer } from "../helpers/http.js";
import { canBindLocalPort } from "../helpers/network.js";
import { waitFor } from "../helpers/wait.js";

function signBody(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
}

async function postSlackEvent(
  baseUrl: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signBody(secret, timestamp, body);

  return fetch(`${baseUrl}/api/ava/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

async function postSlackInteraction(
  baseUrl: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signBody(secret, timestamp, body);

  return fetch(`${baseUrl}/api/ava/slack/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

const canListen = await canBindLocalPort();
const describeIfNetwork = canListen ? describe : describe.skip;

describeIfNetwork("e2e: slack routes", () => {
  let server: Server;
  let baseUrl = "";
  const signingSecret = "test-signing-secret";

  beforeEach(async () => {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    handleSlackMessageMock.mockReset();
    storePendingMessageMock.mockReset();
    injectSystemEventMock.mockReset();
    resolveExecApprovalDecisionBySlackUserMock.mockReset();
    resolveThreadDispatchStateMock.mockReset();
    resolveThreadDispatchStateMock.mockResolvedValue(null);

    vi.resetModules();
    const { createServer } = await import("../../src/api/server.js");
    const app = createServer();
    const started = await startHttpServer(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    await closeHttpServer(server);
  });

  test("accepts signed app_mention event and deduplicates retries", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as Record<string, unknown>;

    const first = await postSlackEvent(baseUrl, signingSecret, payload);
    expect(first.status).toBe(200);

    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "handleSlackMessage was not called for app_mention",
    });

    const second = await postSlackEvent(baseUrl, signingSecret, payload);
    expect(second.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  test("deduplicates app_mention replay when retry has a different event_id", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as {
      event_id?: string;
      event?: { ts?: string };
    };

    const first = await postSlackEvent(baseUrl, signingSecret, payload as never);
    expect(first.status).toBe(200);
    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "initial app_mention delivery did not run",
    });

    const replay = {
      ...payload,
      event_id: `${payload.event_id ?? "EvRetry"}-retry`,
      event: {
        ...payload.event,
        // Keep same ts to simulate Slack replay with mutated envelope id.
        ts: payload.event?.ts ?? "1700000000.000100",
      },
    };

    const second = await postSlackEvent(baseUrl, signingSecret, replay as never);
    expect(second.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  test("does not double-run when app_mention and message arrive for same ts", async () => {
    const mentionPayload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as Record<string, unknown>;

    const messagePayload = structuredClone(mentionPayload) as {
      event?: { type?: string };
    };
    if (messagePayload.event) {
      messagePayload.event.type = "message";
    }

    const mentionResponse = await postSlackEvent(baseUrl, signingSecret, mentionPayload);
    expect(mentionResponse.status).toBe(200);
    const messageResponse = await postSlackEvent(baseUrl, signingSecret, messagePayload as never);
    expect(messageResponse.status).toBe(200);

    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "dual app_mention/message delivery triggered extra runs",
    });
    expect(handleSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  test("does not drop mention when message arrives before app_mention", async () => {
    const mentionPayload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as Record<string, unknown>;

    const messagePayload = structuredClone(mentionPayload) as {
      event?: { type?: string };
    };
    if (messagePayload.event) {
      messagePayload.event.type = "message";
    }

    const messageResponse = await postSlackEvent(baseUrl, signingSecret, messagePayload as never);
    expect(messageResponse.status).toBe(200);
    const mentionResponse = await postSlackEvent(baseUrl, signingSecret, mentionPayload);
    expect(mentionResponse.status).toBe(200);

    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "message-first mention delivery did not trigger exactly one run",
    });
    expect(handleSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(storePendingMessageMock).not.toHaveBeenCalled();
  });

  test("routes message-only explicit mentions through dispatch", async () => {
    const messagePayload = JSON.parse(
      readFileSync("test/fixtures/slack/event-app-mention.json", "utf-8"),
    ) as {
      event?: { type?: string };
    };
    if (messagePayload.event) {
      messagePayload.event.type = "message";
    }

    const response = await postSlackEvent(baseUrl, signingSecret, messagePayload as never);
    expect(response.status).toBe(200);

    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "message-only mention was not dispatched",
    });
    expect(handleSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(storePendingMessageMock).not.toHaveBeenCalled();
  });

  test("ignores signed thread message events without AVA signal when thread is inactive", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-thread-message.json", "utf-8"),
    ) as Record<string, unknown>;

    resolveThreadDispatchStateMock.mockResolvedValueOnce(null);

    const response = await postSlackEvent(baseUrl, signingSecret, payload);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handleSlackMessageMock).not.toHaveBeenCalled();
    expect(storePendingMessageMock).not.toHaveBeenCalled();
  });

  test("routes signed thread message events without AVA signal when thread is active", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/event-thread-message.json", "utf-8"),
    ) as Record<string, unknown>;

    resolveThreadDispatchStateMock.mockResolvedValueOnce({
      sessionId: "S1",
      ownerUserId: "U123",
      hasActiveRun: false,
      hasPendingQueue: false,
      hasRunningSubagents: false,
    });

    const response = await postSlackEvent(baseUrl, signingSecret, payload);
    expect(response.status).toBe(200);

    await waitFor(() => handleSlackMessageMock.mock.calls.length === 1, {
      timeoutMs: 2_000,
      message: "thread reply was not queued",
    });

    expect(storePendingMessageMock).not.toHaveBeenCalled();
  });

  test("handles url verification challenge", async () => {
    const payload = JSON.parse(
      readFileSync("test/fixtures/slack/url-verification.json", "utf-8"),
    ) as Record<string, unknown>;

    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signBody(signingSecret, timestamp, body);

    const response = await fetch(`${baseUrl}/api/ava/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { challenge: string };
    expect(json.challenge).toBe("challenge-token");
  });

  test("resolves signed interaction when actor is authorized", async () => {
    resolveExecApprovalDecisionBySlackUserMock.mockResolvedValue({ ok: true });

    const response = await postSlackInteraction(baseUrl, signingSecret, {
      type: "block_actions",
      user: { id: "U123" },
      actions: [
        {
          action_id: "exec_approval_decision",
          value: JSON.stringify({
            approvalId: "approval-authorized",
            decision: "allow-once",
          }),
        },
      ],
    });

    expect(response.status).toBe(200);
    await waitFor(
      () => resolveExecApprovalDecisionBySlackUserMock.mock.calls.length === 1,
      { timeoutMs: 2_000, message: "interaction resolver was not called" },
    );
    expect(resolveExecApprovalDecisionBySlackUserMock).toHaveBeenCalledWith({
      approvalId: "approval-authorized",
      decision: "allow-once",
      slackUserId: "U123",
    });
  });

  test("rejects signed interaction when actor is unauthorized", async () => {
    resolveExecApprovalDecisionBySlackUserMock.mockResolvedValue({
      ok: false,
      reason: "not authorized to resolve this approval",
    });

    const response = await postSlackInteraction(baseUrl, signingSecret, {
      type: "block_actions",
      user: { id: "U999" },
      actions: [
        {
          action_id: "exec_approval_decision",
          value: JSON.stringify({
            approvalId: "approval-unauthorized",
            decision: "deny",
          }),
        },
      ],
    });

    expect(response.status).toBe(200);
    await waitFor(
      () => resolveExecApprovalDecisionBySlackUserMock.mock.calls.length === 1,
      { timeoutMs: 2_000, message: "unauthorized interaction was not processed" },
    );
    expect(resolveExecApprovalDecisionBySlackUserMock).toHaveBeenCalledWith({
      approvalId: "approval-unauthorized",
      decision: "deny",
      slackUserId: "U999",
    });
  });
});
