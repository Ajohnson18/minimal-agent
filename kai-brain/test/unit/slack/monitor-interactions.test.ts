import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SlackMonitorContext } from "../../../src/slack/monitor/context.js";

const { resolveExecApprovalDecisionBySlackUserMock } = vi.hoisted(() => ({
  resolveExecApprovalDecisionBySlackUserMock: vi.fn(),
}));

vi.mock("../../../src/services/exec-approval.service.js", () => ({
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

import { handleSlackInteractionEvent } from "../../../src/slack/monitor/events/interactions.js";

function createContext(): SlackMonitorContext {
  const seen = new Set<string>();
  return {
    accountId: "default",
    mentionPatterns: [],
    mentionGatingMode: "default",
    reactionMode: "off",
    inboundDebounceMs: 0,
    defaultRequireMention: true,
    threadHistoryScope: "thread",
    getMentionConfig: () => ({ patterns: [] }),
    getChannelConfig: () => undefined,
    markEventSeen: () => false,
    markInteractionSeen: (key: string) => {
      if (seen.has(key)) {
        return true;
      }
      seen.add(key);
      return false;
    },
    threadTsResolver: {
      resolve: async ({ message }) => message,
    },
    setBotUserId: () => {},
    getBotUserId: () => undefined,
  };
}

describe("slack monitor interactions", () => {
  beforeEach(() => {
    resolveExecApprovalDecisionBySlackUserMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  test("resolves approval decision for authorized actor", async () => {
    resolveExecApprovalDecisionBySlackUserMock.mockResolvedValue({ ok: true });

    await handleSlackInteractionEvent({
      ctx: createContext(),
      payload: {
        type: "block_actions",
        response_url: "https://example.com/slack-response",
        user: { id: "U123" },
        container: { message_ts: "100.200" },
        actions: [
          {
            action_id: "exec_approval_decision",
            value: JSON.stringify({ approvalId: "a1", decision: "allow-once" }),
          },
        ],
      },
    });

    expect(resolveExecApprovalDecisionBySlackUserMock).toHaveBeenCalledWith({
      approvalId: "a1",
      decision: "allow-once",
      slackUserId: "U123",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("returns unauthorized feedback when resolver denies actor", async () => {
    resolveExecApprovalDecisionBySlackUserMock.mockResolvedValue({
      ok: false,
      reason: "not authorized to resolve this approval",
    });

    await handleSlackInteractionEvent({
      ctx: createContext(),
      payload: {
        type: "block_actions",
        response_url: "https://example.com/slack-response",
        user: { id: "U999" },
        container: { message_ts: "100.201" },
        actions: [
          {
            action_id: "exec_approval_decision",
            value: JSON.stringify({ approvalId: "a2", decision: "deny" }),
          },
        ],
      },
    });

    expect(resolveExecApprovalDecisionBySlackUserMock).toHaveBeenCalledTimes(1);
    const request = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      body?: string;
    };
    const parsed = JSON.parse(request.body || "{}") as { text?: string };
    expect(parsed.text).toContain("not authorized");
  });

  test("deduplicates duplicate callbacks for same action payload", async () => {
    resolveExecApprovalDecisionBySlackUserMock.mockResolvedValue({ ok: true });
    const ctx = createContext();
    const payload = {
      type: "block_actions",
      response_url: "https://example.com/slack-response",
      user: { id: "U123" },
      container: { message_ts: "100.202" },
      actions: [
        {
          action_id: "exec_approval_decision",
          value: JSON.stringify({ approvalId: "a3", decision: "allow-once" }),
        },
      ],
    };

    await handleSlackInteractionEvent({
      ctx,
      payload,
    });
    await handleSlackInteractionEvent({
      ctx,
      payload,
    });

    expect(resolveExecApprovalDecisionBySlackUserMock).toHaveBeenCalledTimes(1);
  });
});
