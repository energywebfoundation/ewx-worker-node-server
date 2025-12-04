import { MAIN_CONFIG } from '../config';
import express from 'express';
import { createLogger } from '../util/logger';
import { isLive, isReady } from '../health/health';
import asyncHandler from 'express-async-handler';

export const createHealthRouter = (): express.Router | null => {
  if (!MAIN_CONFIG.ENABLE_HEALTH_API) {
    return null;
  }

  const healthLogger = createLogger('Health');

  const healthRouter: express.Router = express.Router({ mergeParams: true });

  healthRouter.get('/health/liveness', (req, res) => {
    const health = isLive();

    healthLogger.debug('requested liveness');

    res.json(health);
  });

  healthRouter.get(
    '/health/readiness',
    asyncHandler(async (req, res) => {
      const result = await isReady();

      healthLogger.debug(result, 'requested readiness');

      res.json(result);
    }),
  );

  return healthRouter;
};
