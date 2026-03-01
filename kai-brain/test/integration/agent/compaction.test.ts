import { afterAll, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/agent/pi-provider.js", () => ({
  getDefaultProvider: () => "vertex",
  getPiModel: () => ({ provider: "vertex", id: "mock-model" }),
  streamSimple: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "done",
        message: {
          content: [{ type: "text", text: "Compacted summary" }],
        },
      };
    },
  }),
}));

vi.mock("../../../src/agent/memory-extractor.js", () => ({
  extractAndStoreMemories: vi.fn(async () => 2),
}));

import { db } from "../../../src/db/client.js";
import { avaCompactionHistory } from "../../../src/db/schema/compaction.js";
import { avaMessages } from "../../../src/db/schema/messages.js";
import { avaSessions } from "../../../src/db/schema/sessions.js";
import { and, eq } from "drizzle-orm";
import { compactSession } from "../../../src/agent/compaction.js";
import {
  createTestSession,
  deleteSession,
  isTestDatabaseReady,
  uniqueId,
} from "../../helpers/db.js";

const dbReady = await isTestDatabaseReady();
const describeIfDb = dbReady ? describe : describe.skip;

describeIfDb("integration: compaction", () => {
  const createdSessions: string[] = [];

  afterAll(async () => {
    for (const sessionId of createdSessions) {
      await deleteSession(sessionId);
    }
  });

  test("compacts old messages and updates session summary/history", async () => {
    const session = await createTestSession({ userId: uniqueId("compact-user") });
    createdSessions.push(session.id);

    const entries = Array.from({ length: 30 }, (_, index) => ({
      sessionId: session.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
      metadata: {},
      isCompacted: false,
      createdAt: new Date(Date.now() + index),
    }));

    await db.insert(avaMessages).values(entries);

    const result = await compactSession(session.id, session.userId);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Compacted summary");
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.memoriesExtracted).toBe(2);

    const [updatedSession] = await db
      .select({ contextSummary: avaSessions.contextSummary })
      .from(avaSessions)
      .where(eq(avaSessions.id, session.id))
      .limit(1);

    expect(updatedSession?.contextSummary).toContain("Compacted summary");

    const history = await db
      .select()
      .from(avaCompactionHistory)
      .where(eq(avaCompactionHistory.sessionId, session.id));
    expect(history.length).toBe(1);

    const compactedMessages = await db
      .select()
      .from(avaMessages)
      .where(
        and(eq(avaMessages.sessionId, session.id), eq(avaMessages.isCompacted, true)),
      );

    expect(compactedMessages.length).toBe(result.messagesCompacted);
  });

  test("returns unsuccessful result when there are not enough messages", async () => {
    const session = await createTestSession({ userId: uniqueId("compact-user") });
    createdSessions.push(session.id);

    await db.insert(avaMessages).values([
      {
        sessionId: session.id,
        role: "user",
        content: "only one",
        metadata: {},
        isCompacted: false,
      },
    ]);

    const result = await compactSession(session.id, session.userId);

    expect(result.success).toBe(false);
    expect(result.messagesCompacted).toBe(0);
  });
});
