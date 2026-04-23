import { createLogger } from './util';
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

/**
 * Report health for every registered runtime. The output name 'NODE_RED' is
 * preserved for back-compat with any external monitoring that keyed off it.
 */
const isReady = async (): Promise<ComponentHealthStatus[]> => {
  const out: ComponentHealthStatus[] = [];

  for (const rt of ALL_RUNTIMES) {
    out.push(await getRuntimeHealth(rt));
  }

  return out;
};

const componentNameForRuntime = (rt: Runtime): ComponentName => {
  if (rt.id === 'node-red') return ComponentName.RED;
  if (rt.id === 'n8n') return ComponentName.N8N;

  // Exhaustive narrowing; future runtimes added to the Runtime.id union must
  // be named here. TypeScript will flag them as unhandled.
  const exhaustive: never = rt.id;

  throw new Error(`unhandled runtime id: ${exhaustive as string}`);
};

const getRuntimeHealth = async (rt: Runtime): Promise<RuntimeHealthStatus> => {
  const name: ComponentName = componentNameForRuntime(rt);

  try {
    const health = await rt.getHealth();

    return {
      status: health.started ? HealthStatus.OK : HealthStatus.ERROR,
      name,
      additionalDetails: {
        installedSolutions: health.installedSolutions,
        installedSolutionsCount: health.installedSolutions.length,
      },
    };
  } catch {
    return {
      status: HealthStatus.ERROR,
      name,
      additionalDetails: {
        installedSolutions: [],
        installedSolutionsCount: 0,
      },
    };
  }
};
