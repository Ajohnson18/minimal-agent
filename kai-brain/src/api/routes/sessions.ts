import { Router, type Request, type Response } from 'express';
import { db } from '../../db/client.js';
import { avaSessions, avaMessages } from '../../db/schema/index.js';
import { eq, desc, and } from 'drizzle-orm';
import { createLogger } from '../../lib/logger.js';
import { archiveSessionAndTerminateWork } from '../../gateway/services/session-lifecycle-guard.js';
import { sessionKeyResolverService } from '../../services/session-key-resolver.service.js';

export const sessionsRouter: ReturnType<typeof Router> = Router();
const log = createLogger('web', { route: 'sessions' });

function requireAuthenticatedUserId(req: Request, res: Response): string | null {
  const userId = req.auth?.userId?.trim();
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

/**
 * GET /api/ava/sessions
 * List user's sessions
 */
sessionsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const sessions = await db
      .select({
        id: avaSessions.id,
        title: avaSessions.title,
        status: avaSessions.status,
        createdAt: avaSessions.createdAt,
        updatedAt: avaSessions.updatedAt,
        lastMessageAt: avaSessions.lastMessageAt,
        tokenCount: avaSessions.tokenCount,
      })
      .from(avaSessions)
      .where(and(eq(avaSessions.userId, userId), eq(avaSessions.status, 'active')))
      .orderBy(desc(avaSessions.updatedAt))
      .limit(50);

    return res.json({ sessions });
  } catch (error) {
    log.error({ err: error }, 'Error listing sessions');
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/ava/sessions/:id
 * Get session with messages
 */
sessionsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const [session] = await db
      .select()
      .from(avaSessions)
      .where(and(eq(avaSessions.id, sessionId), eq(avaSessions.userId, userId)));

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messages = await db
      .select({
        id: avaMessages.id,
        role: avaMessages.role,
        content: avaMessages.content,
        toolCalls: avaMessages.toolCalls,
        toolCallId: avaMessages.toolCallId,
        name: avaMessages.name,
        createdAt: avaMessages.createdAt,
      })
      .from(avaMessages)
      .where(eq(avaMessages.sessionId, sessionId as string))
      .orderBy(avaMessages.createdAt);

    return res.json({ session, messages });
  } catch (error) {
    log.error({ err: error }, 'Error getting session');
    return res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * POST /api/ava/sessions
 * Create a new session
 */
sessionsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }
    const title = req.body?.title;

    const [session] = await db
      .insert(avaSessions)
      .values({
        userId,
        title: title || 'New conversation',
        status: 'active',
      })
      .returning();

    const identity = await sessionKeyResolverService.ensureBoundIdentity({
      sessionId: session.id,
      agentId: 'main',
      scope: 'web',
    });

    return res.status(201).json({
      session: { ...session, sessionKey: identity?.sessionKey ?? null },
    });
  } catch (error) {
    log.error({ err: error }, 'Error creating session');
    return res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * DELETE /api/ava/sessions/:id
 * Archive a session (soft delete)
 */
sessionsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const [session] = await db
      .select({ id: avaSessions.id })
      .from(avaSessions)
      .where(and(eq(avaSessions.id, sessionId), eq(avaSessions.userId, userId)))
      .limit(1);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await archiveSessionAndTerminateWork(session.id, 'api-session-archive');

    return res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'Error archiving session');
    return res.status(500).json({ error: 'Failed to archive session' });
  }
});
