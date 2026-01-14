import {
  getAllInstalledSolutionsNames,
  getAllInstalledSolutionsWithGroups,
  runtimeStarted,
  type InstalledSolutionDetails,
} from '../node-red/red';
import { createKeyringPair } from '../polkadot/account';
import { MAIN_CONFIG } from '../config';
import { getCachedOperatorAddress } from '../util/operator-address-cache';

enum HealthStatus {
  OK = 'OK',
  ERROR = 'ERROR',
}

enum ComponentName {
  RED = 'NODE_RED',
  READY = 'READY',
}

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

interface SolutionInfo {
  id: string;
  name: string;
  status: string;
  installed: boolean;
}

interface SolutionGroupInfo {
  id: string;
  name?: string;
  hasCidAllowList?: boolean;
  solutions: SolutionInfo[];
}

interface OperatorInfo {
  address: string;
  subscriptions: string[];
  solutionGroups: SolutionGroupInfo[];
}

interface SolutionGroupsDetailsStatus {
  timestamp: string;
  rpcUrl?: string;
  workerAddress?: string;
  operator?: OperatorInfo;
}

export const isLive = (): ComponentHealthStatus => {
  return {
    status: HealthStatus.OK,
    name: 'LIVE',
  };
};

export const isReady = async (): Promise<ComponentHealthStatus[]> => {
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

const getOperatorInfo = async (timeoutMs: number = 5000): Promise<OperatorInfo | undefined> => {
  try {
    const account = createKeyringPair();

    // Get installed solutions with groups from Node-RED (local, fast)
    let installedSolutionsWithGroups: InstalledSolutionDetails[] = [];
    try {
      installedSolutionsWithGroups = await getAllInstalledSolutionsWithGroups();
    } catch {
      return undefined;
    }

    if (installedSolutionsWithGroups.length === 0) {
      // No installed solutions - still need operator address
      const operatorAddress = await getCachedOperatorAddress(account.address, timeoutMs);

      if (operatorAddress == null) {
        return undefined;
      }

      return {
        address: operatorAddress,
        subscriptions: [],
        solutionGroups: [],
      };
    }

    // Extract unique solution group IDs from installed solutions (local data)
    const uniqueSolutionGroupIds = [
      ...new Set(installedSolutionsWithGroups.map((s) => s.solutionGroupId)),
    ];

    // Get operator address (required) - getCachedOperatorAddress handles cache and chain query
    const operatorAddress = await getCachedOperatorAddress(account.address, timeoutMs);

    if (operatorAddress == null) {
      return undefined;
    }

    // Group installed solutions by solutionGroupId (local data)
    const solutionGroupsMap = new Map<string, InstalledSolutionDetails[]>();
    for (const solution of installedSolutionsWithGroups) {
      const group = solutionGroupsMap.get(solution.solutionGroupId) ?? [];
      group.push(solution);
      solutionGroupsMap.set(solution.solutionGroupId, group);
    }

    // Build solution groups from local data
    const solutionGroups: SolutionGroupInfo[] = Array.from(solutionGroupsMap.entries()).map(
      ([solutionGroupId, solutions]) => {
        const solutionInfos: SolutionInfo[] = solutions.map((solution) => {
          // Extract name from solutionId (format: "name.uuid")
          // Example: "newTestGPSaaS.1348d595-ccc4-4a38-85ad-f0e31cc7f410" -> "newTestGPSaaS"
          const name = solution.solutionId.includes('.')
            ? solution.solutionId.split('.').slice(0, -1).join('.')
            : solution.solutionId;

          return {
            id: solution.solutionId,
            name,
            status: 'Active', // Assume active if installed
            installed: true, // All are installed
          };
        });

        return {
          id: solutionGroupId,
          name: solutionGroupId, // Use groupId as name (we don't have name from chain)
          solutions: solutionInfos,
        };
      },
    );

    return {
      address: operatorAddress,
      subscriptions: uniqueSolutionGroupIds,
      solutionGroups,
    };
  } catch {
    return undefined;
  }
};

export const getSolutionGroupsDetailsStatus = async (): Promise<SolutionGroupsDetailsStatus> => {
  const timestamp = new Date().toISOString();

  // Gather configuration (non-sensitive)
  let rpcUrl: string | undefined;
  let workerAddress: string | undefined;
  try {
    const account = createKeyringPair();
    workerAddress = account.address;
    rpcUrl = MAIN_CONFIG.PALLET_RPC_URL;
  } catch {
    rpcUrl = MAIN_CONFIG.PALLET_RPC_URL;
  }

  // Get operator information with solution groups
  const operatorInfo = await getOperatorInfo();

  return {
    timestamp,
    rpcUrl,
    workerAddress,
    operator: operatorInfo,
  };
};
