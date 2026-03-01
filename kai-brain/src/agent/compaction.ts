/**
 * Context Compaction for Pi-Agent
 *
 * Implements Tier 2 of context management: summarizing old messages
 * when context grows too large even after pruning.
 *
 * Also extracts important facts/preferences to long-term memory before compacting.
 */
import { db } from '../db/client.js';
import { avaCompactionHistory, avaSessions, avaMessages } from '../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';
import { PostgresSessionAdapter } from './session-adapter.js';
import { estimateTotalTokens, estimateTokens } from './context-pruning.js';
import { streamSimple, getPiModel, getDefaultProvider } from './pi-provider.js';
import { extractAndStoreMemories } from './memory-extractor.js';
import type { Message, TextContent } from '@mariozechner/pi-ai';
import { compactionLogger as log } from '../lib/logger.js';
import { getConfig } from '../lib/config-loader.js';

// Constants
const COMPACTION_MODEL = 'gemini-2.0-flash';
const COMPACTION_TIMEOUT_MS = 60000;
const COMPACTION_SAFETY_TIMEOUT_MS = 90000;

export function getCompactionSettings() {
  const ctx = getConfig().agent.context;
  return {
    keepRecentMessages: ctx.keepRecentMessages,
    compactionThreshold: ctx.compactionThreshold,
  };
}

/**
 * Compact a session by summarizing old messages.
 *
 * This is Tier 2 of context management:
 * 1. Identifies messages to compact (older than threshold)
 * 2. Extracts important memories before compaction (Phase 7)
 * 3. Generates a summary using LLM
 * 4. Marks old messages as compacted
 * 5. Stores summary in session for future context
 *
 * @param sessionId - The session to compact
 * @param userId - Optional user ID for memory extraction
 */
export async function compactSession(
  sessionId: string,
  userId?: string
): Promise<{
  success: boolean;
  summary?: string;
  messagesCompacted: number;
  memoriesExtracted: number;
  tokensBefore: number;
  tokensAfter: number;
}> {
  // Top-level safety timeout — prevents stalled compaction from blocking the session lane
  const safetyTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Compaction safety timeout after ${COMPACTION_SAFETY_TIMEOUT_MS / 1000}s — aborting to unblock session`));
    }, COMPACTION_SAFETY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([compactSessionInner(sessionId, userId), safetyTimeout]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ sessionId, err: msg }, 'Compaction safety timeout');
    return {
      success: false,
      messagesCompacted: 0,
      memoriesExtracted: 0,
      tokensBefore: 0,
      tokensAfter: 0,
    };
  }
}

async function compactSessionInner(
  sessionId: string,
  userId?: string
): Promise<{
  success: boolean;
  summary?: string;
  messagesCompacted: number;
  memoriesExtracted: number;
  tokensBefore: number;
  tokensAfter: number;
}> {
  const settings = getCompactionSettings();
  const sessionAdapter = new PostgresSessionAdapter(sessionId);

  // 1. Load all messages
  const messages = await sessionAdapter.loadMessages();

  // 2. Check if we have enough messages to compact
  if (messages.length <= settings.keepRecentMessages) {
    return {
      success: false,
      messagesCompacted: 0,
      memoriesExtracted: 0,
      tokensBefore: 0,
      tokensAfter: 0,
    };
  }

  // 3. Split messages into compact and keep
  const compactionPoint = messages.length - settings.keepRecentMessages;
  const toCompact = messages.slice(0, compactionPoint);
  // Note: toKeep messages remain in DB, we only summarize toCompact

  // 4. Calculate token counts
  const tokensBefore = estimateTotalTokens(toCompact);

  // 5. Extract memories before compaction (Phase 7 - preserve important info)
  let memoriesExtracted = 0;
  if (userId) {
    try {
      memoriesExtracted = await extractAndStoreMemories(toCompact, userId, sessionId);
    } catch (error) {
      log.error({ err: error }, 'Memory extraction failed, continuing with compaction');
    }
  }

  // 6. Generate summary
  const summary = await generateCompactionSummary(toCompact);

  if (!summary) {
    log.error({ sessionId }, 'Failed to generate compaction summary');
    return {
      success: false,
      messagesCompacted: 0,
      memoriesExtracted,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const tokensAfter = estimateTokens(summary);

  // 6. Save compaction record, mark messages, and update session atomically
  const messageIds = toCompact
    .map((m) => (m as any).id)
    .filter((id): id is string => !!id); // Filter out any without IDs

  await db.transaction(async (tx) => {
    // Insert compaction history
    await tx.insert(avaCompactionHistory).values({
      sessionId,
      summary,
      messagesCompacted: toCompact.length,
      tokensBefore,
      tokensAfter,
    });

    // Mark messages as compacted (batch update)
    if (messageIds.length > 0) {
      await tx
        .update(avaMessages)
        .set({ isCompacted: true })
        .where(inArray(avaMessages.id, messageIds));
    }

    // Update session with context summary
    await tx
      .update(avaSessions)
      .set({ contextSummary: summary })
      .where(eq(avaSessions.id, sessionId));
  });

  log.info({
    sessionId,
    messagesCompacted: toCompact.length,
    tokensBefore,
    tokensAfter,
    reductionPct: Math.round((1 - tokensAfter / tokensBefore) * 100),
    memoriesExtracted,
  }, 'Session compacted');

  return {
    success: true,
    summary,
    messagesCompacted: toCompact.length,
    memoriesExtracted,
    tokensBefore,
    tokensAfter,
  };
}

/**
 * Generate a summary of messages for compaction.
 */
async function generateCompactionSummary(messages: Message[]): Promise<string | null> {
  if (messages.length === 0) return null;

  // Build conversation text
  const conversationText = messages
    .map((msg) => {
      const role = msg.role === 'toolResult' ? 'tool' : msg.role;
      let content: string;

      if (msg.role === 'user') {
        content = typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((c) => c.type === 'text')
              .map((c) => (c as TextContent).text)
              .join('\n');
      } else if (msg.role === 'assistant') {
        content = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as TextContent).text)
          .join('\n');
      } else if (msg.role === 'toolResult') {
        content = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as TextContent).text)
          .join('\n');
      } else {
        content = '';
      }

      return `[${role.toUpperCase()}]: ${content}`;
    })
    .join('\n\n');

  // Create summarization prompt
  const systemPrompt = `You are a conversation summarizer. Your task is to create a concise summary of the conversation that captures:
1. Key topics discussed
2. Important decisions made
3. Tasks completed
4. Outstanding items or next steps
5. Any critical information the AI assistant should remember

Keep the summary focused and actionable. It will be used to provide context for future interactions.`;

  const userPrompt = `Please summarize the following conversation:\n\n${conversationText}\n\nProvide a structured summary that captures the essential context.`;

  try {
    const model = getPiModel(getDefaultProvider(), COMPACTION_MODEL);

    const stream = streamSimple(model, {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
    });

    // Collect the response with timeout
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error('Compaction stream timeout')), COMPACTION_TIMEOUT_MS);
    });

    const streamPromise = (async () => {
      let summary = '';
      for await (const event of stream) {
        // Use final message content (most reliable)
        if (event.type === 'done') {
          const textContent = event.message.content.find((c) => c.type === 'text') as TextContent | undefined;
          if (textContent) {
            summary = textContent.text;
          }
        }
      }
      return summary || null;
    })();

    return await Promise.race([streamPromise, timeoutPromise]);
  } catch (error) {
    log.error({ err: error }, 'Error generating compaction summary');
    return null;
  }
}

/**
 * Check if a session should be compacted.
 */
export async function shouldCompactSession(sessionId: string): Promise<boolean> {
  const settings = getCompactionSettings();
  const sessionAdapter = new PostgresSessionAdapter(sessionId);
  const messages = await sessionAdapter.loadMessages();

  return messages.length > settings.compactionThreshold;
}

/**
 * Get the context summary for a session (if available).
 */
export async function getContextSummary(sessionId: string): Promise<string | null> {
  const sessionAdapter = new PostgresSessionAdapter(sessionId);
  const session = await sessionAdapter.getSessionMetadata();
  return session?.contextSummary || null;
}
