import { createLogger, createReadPalletApi } from './util';
import {
  getAllInstalledSolutionsNames,
  getNodeEnv,
  getTabNodes,
  runtimeStarted,
} from './node-red/red';
import express from 'express';
import asyncHandler from 'express-async-handler';
import { MAIN_CONFIG } from './config';
import { createKeyringPair } from './account';
import {
  getOperatorAddress,
  getOperatorSubscriptions,
  getSolutionGroupsByIds,
  getSolutions,
  retryHttpAsyncCall,
} from './polkadot/polka';
import type { ApiPromise } from '@polkadot/api';

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

  healthRouter.get(
    '/health/status',
    asyncHandler(async (req, res) => {
      const result = await getComprehensiveHealthStatus();

      healthLogger.debug(result, 'requested comprehensive health status');

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

interface ComprehensiveHealthStatus {
  rpcUrl: string;
  workerAddress: string;
  operator: {
    address: string | null;
    subscriptions: string[];
    solutionGroups: Array<{
      id: string;
      name?: string;
      hasCidAllowList: boolean;
      solutions: Array<{
        id: string;
        name?: string;
        status: string;
        installed: boolean;
      }>;
    }>;
  };
  timestamp: string;
}

const getComprehensiveHealthStatus = async (): Promise<ComprehensiveHealthStatus> => {
  // Get worker account and RPC URL
  const account = createKeyringPair();
  const rpcUrl = MAIN_CONFIG.PALLET_RPC_URL;
  const workerAddress = account.address;

  // Fetch operator information in real-time
  let operatorAddress: string | null = null;
  let operatorSubscriptions: string[] = [];
  const solutionGroups: Array<{
    id: string;
    name?: string;
    hasCidAllowList: boolean;
    solutions: Array<{
      id: string;
      name?: string;
      status: string;
      installed: boolean;
    }>;
  }> = [];

  // Get installed solutions from Node-RED with their group IDs
  const installedSolutionsMap = new Map<string, { solutionId: string; solutionGroupId: string }>();
  try {
    const tabNodes = await getTabNodes();
    for (const tabNode of tabNodes) {
      const solutionId = getNodeEnv(tabNode, 'EWX_SOLUTION_ID', false);
      const solutionGroupId = getNodeEnv(tabNode, 'EWX_SOLUTION_GROUP_ID', false);

      if (solutionId != null && solutionGroupId != null) {
        installedSolutionsMap.set(solutionId, { solutionId, solutionGroupId });
      }
    }
  } catch (error) {
    const healthLogger = createLogger('Health');
    healthLogger.warn({ error }, 'failed to get installed solutions from Node-RED');
  }

  try {
    const api: ApiPromise = await retryHttpAsyncCall(async () => await createReadPalletApi());

    try {
      operatorAddress = await getOperatorAddress(api, account.address);

      if (operatorAddress != null) {
        operatorSubscriptions = await getOperatorSubscriptions(api, operatorAddress);

        if (operatorSubscriptions.length > 0) {
          const solutionGroupsData = await getSolutionGroupsByIds(api, operatorSubscriptions);
          const allSolutions = await getSolutions(api);

          // Filter solutions that belong to subscribed solution groups
          const subscribedSolutions = allSolutions.filter((solution) =>
            operatorSubscriptions.includes(solution[1] ?? ''),
          );

          // Group solutions by solution group ID
          const solutionsByGroup = new Map<string, Array<(typeof subscribedSolutions)[0]>>();
          for (const solution of subscribedSolutions) {
            const groupId = solution[1];
            if (groupId != null) {
              if (!solutionsByGroup.has(groupId)) {
                solutionsByGroup.set(groupId, []);
              }
              solutionsByGroup.get(groupId)?.push(solution);
            }
          }

          // Convert solution groups to array format with their solutions
          for (const [groupId, groupData] of Object.entries(solutionGroupsData)) {
            const groupSolutions = solutionsByGroup.get(groupId) ?? [];

            solutionGroups.push({
              id: groupId,
              name: groupData.info?.name,
              hasCidAllowList: groupData.hasCidAllowList,
              solutions: groupSolutions.map((solution) => {
                const solutionId = solution[0];
                const solutionData = solution[2];
                const isInstalled = installedSolutionsMap.has(solutionId);

                return {
                  id: solutionId,
                  name: solutionData.info?.name,
                  status: solution[3],
                  installed: isInstalled,
                };
              }),
            });
          }
        }
      }
    } finally {
      await api.disconnect();
    }
  } catch (error) {
    // If fetching fails, log warning but continue with empty values
    const healthLogger = createLogger('Health');
    healthLogger.warn({ error }, 'failed to fetch real-time operator info');
  }

  return {
    rpcUrl,
    workerAddress,
    operator: {
      address: operatorAddress,
      subscriptions: operatorSubscriptions,
      solutionGroups,
    },
    timestamp: new Date().toISOString(),
  };
};
