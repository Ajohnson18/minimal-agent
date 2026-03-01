import { Router, type Request, type Response } from 'express';
import {
  listCredentialKeys,
  setCredentialKey,
  deleteCredentialKey,
  getUserById,
} from '../../services/user.service.js';
import { resolveUser } from '../../services/user.service.js';
import { getSkillTreeNodes, updateSkillTreeNode, unlockChildSkills } from '../../services/settings.service.js';
import { createLogger } from '../../lib/logger.js';

export const credentialsRouter: ReturnType<typeof Router> = Router();
const log = createLogger('web', { route: 'credentials' });

async function resolveDbUser(req: Request, res: Response): Promise<{ id: string; role: string } | null> {
  const jwtUserId = req.auth?.userId?.trim();
  if (!jwtUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    const user = await resolveUser('web', jwtUserId);
    return { id: user.id, role: user.role };
  } catch (err) {
    log.error({ err, jwtUserId }, 'Failed to resolve user');
    res.status(500).json({ error: 'Failed to resolve user' });
    return null;
  }
}

/**
 * GET /api/ava/me
 */
credentialsRouter.get('/me', async (req: Request, res: Response) => {
  const user = await resolveDbUser(req, res);
  if (!user) return;

  const dbUser = await getUserById(user.id);
  return res.json({
    id: dbUser?.id,
    displayName: dbUser?.displayName,
    role: dbUser?.role,
  });
});

/**
 * GET /api/ava/me/credentials
 */
credentialsRouter.get('/me/credentials', async (req: Request, res: Response) => {
  const user = await resolveDbUser(req, res);
  if (!user) return;

  try {
    const keys = await listCredentialKeys(user.id);
    return res.json({ keys });
  } catch (err) {
    log.error({ err }, 'Error listing credentials');
    return res.status(500).json({ error: 'Failed to list credentials' });
  }
});

/**
 * PUT /api/ava/me/credentials/:key
 */
credentialsRouter.put('/me/credentials/:key', async (req: Request, res: Response) => {
  const user = await resolveDbUser(req, res);
  if (!user) return;

  const key = req.params.key as string;
  const { value } = req.body;

  if (!value || typeof value !== 'string') {
    return res.status(400).json({ error: 'value is required' });
  }

  try {
    await setCredentialKey(user.id, key, value);

    const nodes = await getSkillTreeNodes();
    const matchingNode = nodes.find((n) => n.credentialKey === key && n.nodeType === 'integration' && n.status !== 'active');
    if (matchingNode) {
      await updateSkillTreeNode(matchingNode.id, { status: 'active' });
      await unlockChildSkills(matchingNode.id);
      log.info({ nodeId: matchingNode.id, key }, 'Integration node auto-activated via credential');
    }

    return res.json({ saved: key, activatedNode: matchingNode?.id ?? null });
  } catch (err) {
    log.error({ err, key }, 'Error saving credential');
    return res.status(500).json({ error: 'Failed to save credential' });
  }
});

/**
 * DELETE /api/ava/me/credentials/:key
 */
credentialsRouter.delete('/me/credentials/:key', async (req: Request, res: Response) => {
  const user = await resolveDbUser(req, res);
  if (!user) return;

  const key = req.params.key as string;

  try {
    const deleted = await deleteCredentialKey(user.id, key);
    if (!deleted) return res.status(404).json({ error: 'Credential not found' });

    // Deactivate matching integration node and lock child skills
    const nodes = await getSkillTreeNodes();
    const matchingNode = nodes.find((n) => n.credentialKey === key && n.nodeType === 'integration' && n.status === 'active');
    if (matchingNode) {
      await updateSkillTreeNode(matchingNode.id, { status: 'available' });
      const childSkills = nodes.filter((n) => n.requiresIntegration === matchingNode.id);
      for (const child of childSkills) {
        if (child.status === 'active') {
          await updateSkillTreeNode(child.id, { status: 'locked' });
        }
      }
      log.info({ nodeId: matchingNode.id, key }, 'Integration node deactivated via credential removal');
    }

    return res.json({ deleted: key, deactivatedNode: matchingNode?.id ?? null });
  } catch (err) {
    log.error({ err, key }, 'Error deleting credential');
    return res.status(500).json({ error: 'Failed to delete credential' });
  }
});
