import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const executeAgentWithPiMock = vi.hoisted(() => vi.fn());
const postMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/executor-pi.js", () => ({
  executeAgentWithPi: executeAgentWithPiMock,
}));

vi.mock("../../src/lib/slack/app.js", () => ({
  getSlackApp: () => ({
    client: {
      chat: {
        postMessage: postMessageMock,
      },
    },
  }),
}));

import {
  resetHeartbeatsForTests,
  startHeartbeat,
  wakeHeartbeat,
} from "../../src/gateway/services/heartbeat.service.js";
import { runOutboundPumpOnce } from "../../src/gateway/services/outbound-delivery-pump.js";
import { queueService } from "../../src/gateway/services/queue.js";
import { queueSystemEvent } from "../../src/gateway/services/system-events.js";
import { sessionBindingService } from "../../src/services/session-binding.service.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../helpers/db.js";
import {
  resetReliabilityRuntimeForTests,
} from "../helpers/reliability-harness.js";
import { truncateReliabilityTables } from "../helpers/reliability-db.js";

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function driveOutboundUntil(
  predicate: () => boolean,
  opts?: { stepMs?: number; maxIterations?: number },
): Promise<boolean> {
  const stepMs = Math.max(1, Math.floor(opts?.stepMs ?? 250));
  const maxIterations = Math.max(1, Math.floor(opts?.maxIterations ?? 80));

  for (let i = 0; i < maxIterations; i += 1) {
    if (predicate()) {
      return true;
    }
    await runOutboundPumpOnce({ reason: "race-fuzz-drain" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(stepMs);
  }

  return predicate();
}

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("reliability: race/fuzz", () => {
  const sessions = new Set<string>();

  beforeEach(async () => {
    resetReliabilityRuntimeForTests();
    await truncateReliabilityTables();

    executeAgentWithPiMock.mockReset();
    executeAgentWithPiMock.mockResolvedValue({
      content: '{"v":1,"action":"deliver","message":"Fuzz completion payload"}',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [],
    });

    postMessageMock.mockReset();
  });

  afterEach(() => {
    resetHeartbeatsForTests();
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const sessionId of sessions) {
      await deleteSession(sessionId);
    }
  });

  test("seeded wake/binding/queue interleavings converge to single final completion", async () => {
    vi.useFakeTimers();

    const rawSeeds = Number(process.env.AVA_RELIABILITY_SEEDS ?? "6");
    const seedCount = Number.isFinite(rawSeeds) && rawSeeds > 0 ? rawSeeds : 6;

    for (let seed = 1; seed <= seedCount; seed += 1) {
      await truncateReliabilityTables();
      resetReliabilityRuntimeForTests();

      const random = createSeededRandom(seed);
      const delivered: Array<{ channel: string; text: string; thread_ts?: string }> = [];
      let remainingFailures = seed % 2;

      postMessageMock.mockImplementation(async (payload) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("transient-send-failure");
        }
        delivered.push(payload);
        return { ok: true, ts: `${seed}.1` };
      });

      const session = await createTestSession({
        userId: uniqueId(`fuzz-user-${seed}`),
        source: "slack",
        externalId: `slack:COLD:${seed}.100`,
      });
      sessions.add(session.id);

      await sessionBindingService.updateBindingFromInbound(session.id, {
        channel: "slack",
        externalId: `slack:CBOUND:${seed}.200`,
      });

      startHeartbeat({
        enabled: true,
        intervalMs: 24 * 60 * 60 * 1000,
        workspaceDir: process.cwd(),
        userId: session.userId,
        sessionId: session.id,
        externalId: session.externalId ?? undefined,
      });

      await queueSystemEvent({
        sessionId: session.id,
        kind: "subagent.completion",
        payload: {
          text: `fuzz payload seed ${seed}`,
          outcome: "completed",
        },
        eventKey: `fuzz:${seed}`,
      });

      let queueBusy = false;
      if (random() < 0.5) {
        await queueService.enqueue(session.id, session.userId, `busy-seed-${seed}`, {
          mode: "followup",
        });
        queueBusy = true;
      }

      for (let step = 0; step < 8; step += 1) {
        if (random() < 0.9) {
          wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });
        }

        if (random() < 0.4) {
          const routeSuffix = Math.floor(random() * 1000);
          await sessionBindingService.updateBindingFromInbound(session.id, {
            channel: "slack",
            externalId: `slack:CBOUND:${seed}.${routeSuffix}`,
          });
        }

        if (queueBusy && random() < 0.35) {
          await queueService.cancelPending(session.id);
          queueBusy = false;
        }

        const advanceMs = Math.floor(random() * 600) + 100;
        await vi.advanceTimersByTimeAsync(advanceMs);
      }

      await queueService.cancelPending(session.id);
      wakeHeartbeat(session.id, { kind: "event", eventKind: "subagent.completion", source: "subagent" });

      await vi.advanceTimersByTimeAsync(10_000);
      await driveOutboundUntil(() => delivered.length >= 1, {
        stepMs: 250,
        maxIterations: 120,
      });

      expect(
        delivered.length,
        `seed ${seed} should produce exactly one delivered completion`,
      ).toBe(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await driveOutboundUntil(() => false, {
        stepMs: 500,
        maxIterations: 20,
      });
      expect(
        delivered.length,
        `seed ${seed} should not emit delayed duplicate completion`,
      ).toBe(1);
    }
  });
});
