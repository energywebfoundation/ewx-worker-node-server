import { createLogger } from './util';
import { getAllInstalledSolutionsNames, runtimeStarted } from './node-red/red';
import express from 'express';
import asyncHandler from 'express-async-handler';
import { MAIN_CONFIG } from './config';
import { ALL_RUNTIMES } from './runtime/registry';
import { type Runtime } from './runtime/runtime';

enum HealthStatus {
  OK = 'OK',
  ERROR = 'ERROR',
}

enum ComponentName {
  RED = 'NODE_RED',
  N8N = 'N8N',
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

interface RuntimeHealthStatus extends ComponentHealthStatus {
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
  // NR health is reported using the legacy check for back-compat with any
  // monitoring that keyed off name === 'NODE_RED'.
  const out: ComponentHealthStatus[] = [await getNodeRedHealth()];

  // Report health for every non-NR runtime the worker has registered.
  for (const rt of ALL_RUNTIMES) {
    if (rt.id === 'node-red') continue;

    out.push(await getRuntimeHealth(rt));
  }

  return out;
};

export const getNodeRedHealth = async (): Promise<RuntimeHealthStatus> => {
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

const getRuntimeHealth = async (rt: Runtime): Promise<RuntimeHealthStatus> => {
  // For non-NR runtimes we infer "started" from whether listing installed
  // solutions works. A runtime that failed to boot will typically throw or
  // return an empty list; either way the report is informative.
  try {
    const installedSolutions: string[] = await rt.getAllInstalledSolutionsNames();

    return {
      status: HealthStatus.OK,
      name: rt.id === 'n8n' ? ComponentName.N8N : rt.id.toUpperCase(),
      additionalDetails: {
        installedSolutions,
        installedSolutionsCount: installedSolutions.length,
      },
    };
  } catch {
    return {
      status: HealthStatus.ERROR,
      name: rt.id === 'n8n' ? ComponentName.N8N : rt.id.toUpperCase(),
      additionalDetails: {
        installedSolutions: [],
        installedSolutionsCount: 0,
      },
    };
  }
};
