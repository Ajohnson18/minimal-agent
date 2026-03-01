/**
 * Chat API Routes
 *
 * Handles chat endpoints for the AVA agent.
 * Uses pi-agent based executor for agent operations.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../../db/client.js';
import { avaSessions, avaMessages } from '../../db/schema/index.js';
import { eq, and, asc } from 'drizzle-orm';
import { executeAgentWithPi, type AgentEvent } from '../../agent/executor-pi.js';
import { getContextSummary } from '../../agent/compaction.js';
import { resolveUserContext } from '../../agent/user-context.js';
import { createLogger } from '../../lib/logger.js';
import { sessionKeyResolverService } from '../../services/session-key-resolver.service.js';
import {
  SANDBOX_UNAVAILABLE_CODE,
  isSandboxUnavailableError,
} from '../../sandbox/errors.js';

export const chatRouter: ReturnType<typeof Router> = Router();
const log = createLogger('web', { route: 'chat' });

interface ChatRequest {
  session_id?: string;
  message: string;
  model?: string;
  provider?: 'vertex' | 'openai' | 'anthropic' | 'google';
}

function requireAuthenticatedUserId(req: Request, res: Response): string | null {
  const userId = req.auth?.userId?.trim();
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

/**
 * POST /api/ava/chat
 * Start or continue a conversation
 */
chatRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { session_id, message, model, provider } = req.body as ChatRequest;
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Get or create session
    let sessionId = session_id;
    if (!sessionId) {
      // Create new session
      const [newSession] = await db
        .insert(avaSessions)
        .values({
          userId,
          title: message.slice(0, 100),
          status: 'active',
        })
        .returning();
      sessionId = newSession.id;
      await sessionKeyResolverService.ensureBoundIdentity({
        sessionId,
        agentId: 'main',
        scope: 'web',
      });
      log.info({ sessionId }, 'Created new chat session');
    } else {
      // Verify session belongs to user
      const [session] = await db
        .select()
        .from(avaSessions)
        .where(and(eq(avaSessions.id, sessionId), eq(avaSessions.userId, userId)));

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
    }

    // Get context summary if available (from previous compaction)
    const contextSummary = await getContextSummary(sessionId);

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Track client connection status
    let clientDisconnected = false;
    res.on('close', () => {
      clientDisconnected = true;
      log.debug({ sessionId }, 'SSE client disconnected');
    });

    // Event handler for streaming (checks if client is still connected)
    const handleEvent = (event: AgentEvent) => {
      if (clientDisconnected || res.writableEnded) {
        return; // Don't write to disconnected client
      }
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        log.warn({ err: error, sessionId }, 'Failed to write SSE event');
        clientDisconnected = true;
      }
    };

    try {
      const userContext = await resolveUserContext('web', userId);

      const result = await executeAgentWithPi({
        sessionId,
        userId,
        userContext,
        prompt: message,
        provider: provider || 'vertex',
        modelId: model,
        contextSummary: contextSummary || undefined,
        onEvent: handleEvent,
      });

      // Send final done event (if client still connected)
      if (!clientDisconnected && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            session_id: sessionId,
            content: result.content,
            usage: result.usage,
          })}\n\n`
        );
      }
    } catch (agentError) {
      log.error({ err: agentError, sessionId }, 'Agent execution error');
      if (isSandboxUnavailableError(agentError) && !res.headersSent) {
        return res.status(503).json({
          error: SANDBOX_UNAVAILABLE_CODE,
          code: SANDBOX_UNAVAILABLE_CODE,
          message: agentError.message,
        });
      }

      if (!clientDisconnected && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            code: isSandboxUnavailableError(agentError)
              ? SANDBOX_UNAVAILABLE_CODE
              : undefined,
            message: agentError instanceof Error
              ? agentError.message
              : 'Agent execution failed',
          })}\n\n`
        );
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  } catch (error) {
    log.error({ err: error }, 'Error processing chat request');

    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: 'An error occurred during chat',
        })}\n\n`
      );
      res.end();
    } else {
      return res.status(500).json({ error: 'Failed to process chat' });
    }
  }
});

/**
 * GET /api/ava/chat/history/:session_id
 * Get chat history for a session
 */
chatRouter.get('/history/:session_id', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.session_id as string;
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    // Verify session belongs to user
    const [session] = await db
      .select()
      .from(avaSessions)
      .where(
        and(
          eq(avaSessions.id, sessionId),
          eq(avaSessions.userId, userId)
        )
      );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Get messages
    const messages = await db
      .select({
        id: avaMessages.id,
        role: avaMessages.role,
        content: avaMessages.content,
        createdAt: avaMessages.createdAt,
        toolCalls: avaMessages.toolCalls,
        name: avaMessages.name,
      })
      .from(avaMessages)
      .where(
        and(
          eq(avaMessages.sessionId, sessionId),
          eq(avaMessages.isCompacted, false)
        )
      )
      .orderBy(asc(avaMessages.createdAt));

    return res.json({
      session,
      messages,
    });
  } catch (error) {
    log.error({ err: error }, 'Error getting chat history');
    return res.status(500).json({ error: 'Failed to get chat history' });
  }
});
