import { getAllInstalledSolutionsNames, runtimeStarted } from '../node-red/red';
import { createKeyringPair } from '../polkadot/account';
import { MAIN_CONFIG } from '../config';
import { getOperatorInfo, type OperatorInfo } from '../util/operator-info';

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
