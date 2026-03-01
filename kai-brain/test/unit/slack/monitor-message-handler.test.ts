import { describe, expect, test } from "vitest";
import { buildSlackDebounceKey } from "../../../src/slack/monitor/message-handler.js";
import type { SlackMessageEvent } from "../../../src/slack/types.js";

function makeMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    channel: "C1",
    user: "U1",
    text: "hello",
    ts: "100.200",
    ...overrides,
  };
}

describe("slack monitor debounce key", () => {
  test("isolates missing-thread path when parent_user_id exists but thread_ts is missing", () => {
    const rootKey = buildSlackDebounceKey({
      accountId: "default",
      message: makeMessage({ parent_user_id: undefined }),
    });

    const maybeThreadKey = buildSlackDebounceKey({
      accountId: "default",
      message: makeMessage({ parent_user_id: "U_PARENT", thread_ts: undefined }),
    });

    expect(rootKey).toBe("slack:default:C1:U1");
    expect(maybeThreadKey).toBe("slack:default:C1:maybe-thread:100.200:U1");
    expect(maybeThreadKey).not.toBe(rootKey);
  });

  test("uses explicit thread bucket when thread_ts is present", () => {
    const key = buildSlackDebounceKey({
      accountId: "default",
      message: makeMessage({ thread_ts: "100.000" }),
    });

    expect(key).toBe("slack:default:C1:100.000:U1");
  });
});
