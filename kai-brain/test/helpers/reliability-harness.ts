import { resetSubagentRegistryForTests } from "../../src/agent/tools/subagent-registry.js";
import { runtime } from "../../src/gateway/runtime.js";
import { resetHeartbeatsForTests } from "../../src/gateway/services/heartbeat.service.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../../src/gateway/services/heartbeat-wake.js";
import {
  hasPendingOutboundPumpWake,
  resetOutboundPumpForTests,
  waitForOutboundPumpIdle,
} from "../../src/gateway/services/outbound-delivery-pump.js";
import { queueProcessor } from "../../src/gateway/services/queue-processor.js";
import { queueService } from "../../src/gateway/services/queue.js";
import {
  clearAllDispatchersForTests,
  waitForDispatchersIdle,
} from "../../src/lib/slack/dispatcher-registry.js";
import {
  listIdempotencyRecords,
  listOutboundJobs,
} from "./reliability-db.js";
import { waitFor } from "./wait.js";

export interface SlackSinkMessage {
  channel: string;
  text: string;
  thread_ts?: string;
  mrkdwn?: boolean;
}

export interface SlackSink {
  readonly messages: SlackSinkMessage[];
  readonly app: {
    client: {
      chat: {
        postMessage: (payload: SlackSinkMessage) => Promise<{ ok: boolean; ts: string }>;
      };
    };
  };
  clear: () => void;
}

let slackTsCounter = 0;

export function createSlackSink(): SlackSink {
  const messages: SlackSinkMessage[] = [];

  return {
    messages,
    app: {
      client: {
        chat: {
          postMessage: async (payload: SlackSinkMessage) => {
            messages.push({ ...payload });
            slackTsCounter += 1;
            return {
              ok: true,
              ts: `${Date.now()}.${String(slackTsCounter).padStart(6, "0")}`,
            };
          },
        },
      },
    },
    clear: () => {
      messages.length = 0;
    },
  };
}

export function resetReliabilityRuntimeForTests(): void {
  queueProcessor.resetForTests();
  queueService.resetForTests();
  runtime.resetForTests();

  resetHeartbeatsForTests();
  resetHeartbeatWakeStateForTests();
  resetOutboundPumpForTests();
  resetSubagentRegistryForTests();

  clearAllDispatchersForTests();
}

export async function waitForReliabilityIdle(opts?: {
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const pollMs = opts?.pollMs ?? 50;

  const [dispatchersIdle, outboundIdle, runtimeIdle] = await Promise.all([
    waitForDispatchersIdle({ timeoutMs, pollMs }),
    waitForOutboundPumpIdle({ timeoutMs, pollMs }),
    runtime.waitForRunsIdle({ timeoutMs, pollMs }),
  ]);

  if (!dispatchersIdle) {
    throw new Error("Timed out waiting for reply dispatchers to become idle");
  }

  if (!outboundIdle) {
    throw new Error("Timed out waiting for outbound pump to become idle");
  }

  if (!runtimeIdle) {
    throw new Error("Timed out waiting for runtime runs to become idle");
  }

  await waitFor(
    () => !hasPendingHeartbeatWake() && !hasPendingOutboundPumpWake(),
    {
      timeoutMs,
      intervalMs: pollMs,
      message: "Timed out waiting for heartbeat/outbound wake queues to clear",
    },
  );
}

export async function assertExactlyOnceByIdempotencyKey(
  idempotencyKey: string,
  opts?: { expectSentJob?: boolean },
): Promise<void> {
  const records = await listIdempotencyRecords({ key: idempotencyKey });
  if (records.length !== 1) {
    throw new Error(
      `Expected exactly one idempotency record for ${idempotencyKey}, found ${records.length}`,
    );
  }

  if (records[0].state !== "sent") {
    throw new Error(
      `Expected idempotency record ${idempotencyKey} to be sent, found state=${records[0].state}`,
    );
  }

  const jobs = await listOutboundJobs({ idempotencyKey });
  const sentJobs = jobs.filter((job) => job.status === "sent");
  const activeJobs = jobs.filter((job) => ["pending", "retry", "sending"].includes(job.status));

  if (sentJobs.length > 1) {
    throw new Error(
      `Expected at most one sent outbound job for ${idempotencyKey}, found ${sentJobs.length}`,
    );
  }

  if ((opts?.expectSentJob ?? false) && sentJobs.length !== 1) {
    throw new Error(
      `Expected exactly one sent outbound job for ${idempotencyKey}, found ${sentJobs.length}`,
    );
  }

  if (activeJobs.length > 0) {
    throw new Error(
      `Expected no active outbound jobs for ${idempotencyKey}, found ${activeJobs.length}`,
    );
  }
}
