import express from 'express';
import asyncHandler from 'express-async-handler';
import { MAIN_CONFIG } from '../config';
import { createLogger } from '../util/logger';
import { getAllInstalledSolutionsNames, runtimeStarted } from '../node-red/red';

enum HealthStatus {
  OK = 'OK',
  ERROR = 'ERROR',
}

enum ComponentName {
  RED = 'NODE_RED',
  READY = 'READY',
}

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

interface ComponentHealthStatus {
  status: HealthStatus;
  name: ComponentName | string;
}

interface NodeRedHealthStatus extends ComponentHealthStatus {
  name: ComponentName.RED;
  additionalDetails: {
    installedSolutions: string[];
    installedSolutionsCount: number;
  };
}

const isLive = (): ComponentHealthStatus => {
  return {
    status: HealthStatus.OK,
    name: 'LIVE',
  };
};

const isReady = async (): Promise<ComponentHealthStatus[]> => {
  return [await getNodeRedHealth()];
};

export const getNodeRedHealth = async (): Promise<NodeRedHealthStatus> => {
  const started = await runtimeStarted();

  if (!started) {
    return {
      status: HealthStatus.ERROR,
      name: ComponentName.RED,
      additionalDetails: {
        installedSolutions: [],
        installedSolutionsCount: 0,
      },
    };
  }

  const installedSolutions: string[] = await getAllInstalledSolutionsNames();

  return {
    status: HealthStatus.OK,
    name: ComponentName.RED,
    additionalDetails: {
      installedSolutions,
      installedSolutionsCount: installedSolutions.length,
    },
  };
};
