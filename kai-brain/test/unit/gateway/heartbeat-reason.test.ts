import { describe, expect, test } from "vitest";

import {
  classifyHeartbeatReason,
  shouldRetryHeartbeatSkip,
} from "../../../src/core/heartbeat-reason.js";

describe("heartbeat reason classifier", () => {
  test("classifies explicit typed event and retry reasons", () => {
    expect(
      classifyHeartbeatReason({
        kind: "event",
        eventKind: "exec.completion",
        source: "exec",
      }),
    ).toMatchObject({
      kind: "event",
      eventKind: "exec.completion",
      source: "exec",
      key: "event:exec.completion",
      priority: 3,
    });

    expect(
      classifyHeartbeatReason({
        kind: "retry",
        retryCause: "queue-busy",
        source: "queue",
      }),
    ).toMatchObject({
      kind: "retry",
      retryCause: "queue-busy",
      source: "queue",
      key: "retry:queue-busy",
      priority: 0,
    });
  });

  test("drops invalid event/retry fields while keeping typed kind", () => {
    expect(
      classifyHeartbeatReason({
        kind: "event",
        eventKind: "not-a-kind" as never,
        source: "exec",
      }),
    ).toMatchObject({
      kind: "event",
      key: "event:unknown",
      priority: 3,
    });

    expect(
      classifyHeartbeatReason({
        kind: "retry",
        retryCause: "not-a-cause" as never,
        source: "queue",
      }),
    ).toMatchObject({
      kind: "retry",
      key: "retry:unknown",
      priority: 0,
    });
  });

  test("retry skip policy is explicit", () => {
    expect(shouldRetryHeartbeatSkip("queue-busy")).toBe(true);
    expect(shouldRetryHeartbeatSkip("delivery-failed")).toBe(true);
    expect(shouldRetryHeartbeatSkip("heartbeat-error")).toBe(true);
    expect(shouldRetryHeartbeatSkip("random-error-string")).toBe(false);
  });
});
