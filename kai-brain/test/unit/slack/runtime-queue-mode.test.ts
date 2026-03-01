import { beforeEach, describe, expect, test, vi } from "vitest";

const killAllForParentMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("../../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: vi.fn(),
}));

vi.mock("../../../src/agent/user-context.js", () => ({
  resolveUserContext: vi.fn(async () => ({ id: "user-ctx", role: "member" })),
}));

vi.mock("../../../src/gateway/services/session-lifecycle-guard.js", () => ({
  archiveSessionAndTerminateWork: vi.fn(async () => {}),
}));

vi.mock("../../../src/lib/config-loader.js", () => ({
  getConfig: () => ({
    logging: {
      level: "info",
      pretty: false,
      redactPaths: [],
      includePid: false,
      includeHostname: false,
    },
    slack: {
      ackEmoji: "eyes",
      ackReactionScope: "all",
      chunkMode: "length",
      humanDelay: { mode: "off", minMs: 0, maxMs: 0 },
      maxConcurrentRuns: 4,
      threadHistoryLimit: 5,
      queueMode: "steer-backlog",
      bashEnabled: false,
      nativeStreaming: false,
    },
  }),
}));

vi.mock("../../../src/db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            { id: "session-stop", metadata: { queueMode: "steer-backlog" } },
          ]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  },
}));

vi.mock("../../../src/agent/tools/subagent-registry.js", () => ({
  killAllForParent: killAllForParentMock,
}));

import { __testing } from "../../../src/slack/monitor/runtime.js";

function queuedMessage(text: string, offsetMs = 0) {
  const messageTs = ((Date.now() + offsetMs) / 1000).toFixed(3);
  return {
    text,
    channelId: "C123",
    threadTs: "1700000000.000",
    messageTs,
  };
}

describe("slack runtime queue modes", () => {
  beforeEach(() => {
    __testing.resetQueueState();
    killAllForParentMock.mockReset();
    killAllForParentMock.mockReturnValue(0);
  });

  test("collect mode batches pending prompts after active run finishes", async () => {
    __testing.setSessionQueueMode("session-collect", "collect");

    let startFirstRun: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startFirstRun = resolve;
    });
    let releaseFirstRun: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });

    const runOrder: string[] = [];
    const runFn = vi.fn(async (text: string) => {
      runOrder.push(text);
      if (text === "first") {
        startFirstRun?.();
        await firstGate;
      }
    });

    const first = __testing.withSessionQueue(
      "session-collect",
      queuedMessage("first", 0),
      "collect",
      runFn,
    );

    await firstStarted;

    const second = __testing.withSessionQueue(
      "session-collect",
      queuedMessage("second", 1),
      "collect",
      runFn,
    );
    const third = __testing.withSessionQueue(
      "session-collect",
      queuedMessage("third", 2),
      "collect",
      runFn,
    );

    releaseFirstRun?.();

    await Promise.all([first, second, third]);

    expect(runOrder).toEqual(["first", "second\n\nthird"]);
  });

  test("steer mode aborts active run and keeps only the latest queued prompt", async () => {
    __testing.setSessionQueueMode("session-steer", "steer");

    let startFirstRun: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startFirstRun = resolve;
    });
    let firstAbortObserved: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => {
      firstAbortObserved = resolve;
    });
    let releaseAbort: (() => void) | undefined;
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });

    const runOrder: string[] = [];
    const runFn = vi.fn(async (text: string, _messageTs: string, signal?: AbortSignal) => {
      runOrder.push(text);
      if (text !== "first") {
        return;
      }

      startFirstRun?.();

      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            firstAbortObserved?.();
            void abortGate.then(() => reject(new Error("aborted")));
          },
          { once: true },
        );
      });
    });

    const first = __testing.withSessionQueue(
      "session-steer",
      queuedMessage("first", 0),
      "steer",
      runFn,
    );

    await firstStarted;

    const second = __testing.withSessionQueue(
      "session-steer",
      queuedMessage("second", 1),
      "steer",
      runFn,
    );

    await abortObserved;

    const third = __testing.withSessionQueue(
      "session-steer",
      queuedMessage("third", 2),
      "steer",
      runFn,
    );

    releaseAbort?.();

    const settled = await Promise.allSettled([first, second, third]);
    expect(settled.some((entry) => entry.status === "rejected")).toBe(true);
    expect(runOrder).toEqual(["first", "third"]);
  });

  test("stop lane also terminates background subagents when no parent run is active", async () => {
    killAllForParentMock.mockReturnValue(2);
    const postMessage = vi.fn(async () => ({ ok: true, ts: "1.2" }));
    const stopped = await __testing.stopActiveRunForThread({
      client: { chat: { postMessage } } as any,
      channelId: "C123",
      threadTs: "1700000000.000",
      ackText: "Stopping current run...",
    });

    expect(stopped).toBe(true);
    expect(killAllForParentMock).toHaveBeenCalledWith("session-stop");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: expect.stringContaining("Also stopped 2 running subagents."),
      }),
    );
  });
});
