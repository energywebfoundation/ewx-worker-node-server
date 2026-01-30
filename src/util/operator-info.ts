import { getAllInstalledSolutionsWithGroups, type InstalledSolutionDetails } from '../node-red/red';
import { createKeyringPair } from '../polkadot/account';
import { getCachedOperatorAddress } from './operator-address-cache';
import { createLogger } from './logger';

const logger = createLogger('OperatorInfo');

// UUID regex (RFC4122: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extracts a display name from solutionId for health/operator info.
 *
 * Use case: EWX solution IDs often follow "name.uuid" (e.g. "newTestGPSaaS.1348d595-ccc4-4a38-85ad-f0e31cc7f410").
 * When the segment after the last dot is a valid UUID, we use the prefix as the human-readable name;
 * otherwise we return the full solutionId (e.g. "a.b.c" or "simpleName").
 *
 * Edge cases: if stripping would yield an empty name (e.g. ".uuid" or malformed ids), returns the
 * full solutionId so the UI never shows an empty name.
 */
const extractSolutionName = (solutionId: string): string => {
  if (solutionId.length === 0) return solutionId;

  const lastDot = solutionId.lastIndexOf('.');
  if (lastDot === -1) return solutionId;

  const lastSegment = solutionId.substring(lastDot + 1);
  if (!UUID_REGEX.test(lastSegment)) return solutionId;

  const name = solutionId.substring(0, lastDot);
  return name.length > 0 ? name : solutionId;
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
