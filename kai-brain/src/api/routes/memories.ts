import { Router, type Request, type Response } from 'express';
import { getUserMemories, deleteMemory } from '../../services/memory.service.js';
import { createLogger } from '../../lib/logger.js';

export const memoriesRouter: ReturnType<typeof Router> = Router();
const log = createLogger('web', { route: 'memories' });

function requireAuthenticatedUserId(req: Request, res: Response): string | null {
  const userId = req.auth?.userId?.trim();
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

memoriesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) return;

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const memories = await getUserMemories(userId, limit);

    return res.json({ memories });
  } catch (error) {
    log.error({ err: error }, 'Error listing memories');
    return res.status(500).json({ error: 'Failed to list memories' });
  }
});

memoriesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = requireAuthenticatedUserId(req, res);
    if (!userId) return;

    await deleteMemory(req.params.id as string);
    return res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'Error deleting memory');
    return res.status(500).json({ error: 'Failed to delete memory' });
  }
});
