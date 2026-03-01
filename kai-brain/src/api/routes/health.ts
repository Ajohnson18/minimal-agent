import { Router, type Request, type Response } from 'express';
import { checkDatabaseConnection } from '../../db/client.js';

export const healthRouter: ReturnType<typeof Router> = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const dbHealthy = await checkDatabaseConnection();

  const status = {
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: {
      database: dbHealthy ? 'connected' : 'disconnected',
    },
  };

  res.status(dbHealthy ? 200 : 503).json(status);
});

healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const dbHealthy = await checkDatabaseConnection();

  if (dbHealthy) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({ ready: false, reason: 'Database not connected' });
  }
});

healthRouter.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ live: true });
});
