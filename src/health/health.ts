import { getAllInstalledSolutionsNames, runtimeStarted } from '../node-red/red';

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
