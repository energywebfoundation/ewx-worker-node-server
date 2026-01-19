import { getAllInstalledSolutionsWithGroups, type InstalledSolutionDetails } from '../node-red/red';
import { createKeyringPair } from '../polkadot/account';
import { getCachedOperatorAddress } from './operator-address-cache';
import { createLogger } from './logger';

const logger = createLogger('OperatorInfo');

// UUID regex (RFC4122: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extracts solution name, removing UUID suffix if present
const extractSolutionName = (solutionId: string): string => {
  const lastDot = solutionId.lastIndexOf('.');
  if (lastDot === -1) return solutionId;

  const lastSegment = solutionId.substring(lastDot + 1);
  return UUID_REGEX.test(lastSegment) ? solutionId.substring(0, lastDot) : solutionId;
};

export enum SolutionStatus {
  ACTIVE = 'Active',
}

export interface SolutionInfo {
  id: string;
  name: string;
  status: SolutionStatus | string;
  installed: boolean;
}

export interface SolutionGroupInfo {
  id: string;
  name?: string;
  hasCidAllowList?: boolean;
  solutions: SolutionInfo[];
}

export interface OperatorInfo {
  address: string;
  subscriptions: string[];
  solutionGroups: SolutionGroupInfo[];
}

export const getOperatorInfo = async (timeoutMs: number = 5000): Promise<OperatorInfo | null> => {
  try {
    const account = createKeyringPair();

    // Get installed solutions with groups from Node-RED (local, fast)
    let installedSolutionsWithGroups: InstalledSolutionDetails[] = [];
    try {
      installedSolutionsWithGroups = await getAllInstalledSolutionsWithGroups();
    } catch (error) {
      logger.error({ error }, 'failed to get installed solutions with groups');
      return null;
    }

    if (installedSolutionsWithGroups.length === 0) {
      // No installed solutions - still need operator address
      const operatorAddress = await getCachedOperatorAddress(account.address, timeoutMs);

      if (operatorAddress == null) {
        return null;
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
      return null;
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
          // Extract name from solutionId, handling UUID suffix if present
          const name = extractSolutionName(solution.solutionId);

          return {
            id: solution.solutionId,
            name,
            status: SolutionStatus.ACTIVE, // Assume active if installed
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
  } catch (error) {
    logger.error({ error }, 'failed to get operator info');
    return null;
  }
};
