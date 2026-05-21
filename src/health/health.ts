import { createKeyringPair } from '../polkadot/account';
import { MAIN_CONFIG } from '../config';
import { getOperatorInfo, type OperatorInfo } from '../util/operator-info';
import { ALL_RUNTIMES } from '../runtime/registry';

enum HealthStatus {
  OK = 'OK',
  ERROR = 'ERROR',
}

// Back-compat label preserved so existing monitoring keyed on 'NODE_RED' still
// finds its line item.
const NODE_RED_HEALTH_LABEL = 'NODE_RED';

interface ComponentHealthStatus {
  status: HealthStatus;
  name: string;
  additionalDetails?: {
    installedSolutions: string[];
    installedSolutionsCount: number;
  };
}

interface SolutionGroupsDetailsStatus {
  timestamp: string;
  rpcUrl?: string;
  workerAddress?: string;
  operator?: OperatorInfo | null;
}

export const isLive = (): ComponentHealthStatus => {
  return {
    status: HealthStatus.OK,
    name: 'LIVE',
  };
};

/**
 * Collect health for every registered runtime in one pass. Runtime.id drives
 * the reported component name, with Node-RED keeping the legacy 'NODE_RED'
 * label for back-compat with existing monitoring.
 */
export const isReady = async (): Promise<ComponentHealthStatus[]> => {
  const out: ComponentHealthStatus[] = [];

  for (const rt of ALL_RUNTIMES) {
    const name: string = rt.id === 'node-red' ? NODE_RED_HEALTH_LABEL : rt.id.toUpperCase();

    try {
      const health = await rt.getHealth();

      out.push({
        status: health.started ? HealthStatus.OK : HealthStatus.ERROR,
        name,
        additionalDetails: {
          installedSolutions: health.installedSolutions,
          installedSolutionsCount: health.installedSolutions.length,
        },
      });
    } catch {
      out.push({
        status: HealthStatus.ERROR,
        name,
        additionalDetails: {
          installedSolutions: [],
          installedSolutionsCount: 0,
        },
      });
    }
  }

  return out;
};

/**
 * Back-compat helper: some external call sites expect a Node-RED specific
 * health report. Internally this just surfaces the NR runtime's health, so it
 * stays consistent with isReady().
 */
export const getNodeRedHealth = async (): Promise<ComponentHealthStatus> => {
  const nr = ALL_RUNTIMES.find((r) => r.id === 'node-red');

  if (nr == null) {
    return {
      status: HealthStatus.ERROR,
      name: NODE_RED_HEALTH_LABEL,
      additionalDetails: { installedSolutions: [], installedSolutionsCount: 0 },
    };
  }

  try {
    const health = await nr.getHealth();

    return {
      status: health.started ? HealthStatus.OK : HealthStatus.ERROR,
      name: NODE_RED_HEALTH_LABEL,
      additionalDetails: {
        installedSolutions: health.installedSolutions,
        installedSolutionsCount: health.installedSolutions.length,
      },
    };
  } catch {
    return {
      status: HealthStatus.ERROR,
      name: NODE_RED_HEALTH_LABEL,
      additionalDetails: { installedSolutions: [], installedSolutionsCount: 0 },
    };
  }
};

export const getSolutionGroupsDetailsStatus = async (): Promise<SolutionGroupsDetailsStatus> => {
  const timestamp = new Date().toISOString();
  const rpcUrl = MAIN_CONFIG.PALLET_RPC_URL;

  let account: ReturnType<typeof createKeyringPair>;
  try {
    account = createKeyringPair();
  } catch {
    // No worker identity (e.g. config not ready); return config only
    return { timestamp, rpcUrl };
  }

  const workerAddress = account.address;
  const operatorInfo = await getOperatorInfo();

  return {
    timestamp,
    rpcUrl,
    workerAddress,
    operator: operatorInfo,
  };
};
