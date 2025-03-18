import express from 'express';
import { MAIN_CONFIG } from '../config';
import * as RED from 'node-red';
import * as http from 'http';
import { type Flows } from '@node-red/runtime';
import { type ParsedFlow, type RedNode, type RedNodes } from '../types';
import { createLogger, sleep } from '../util';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import {
  getNodeRedSolutionNamespace,
  NODE_RED_LOG_LEVELS,
  REVERSED_NODE_RED_LOG_LEVELS,
} from './node-red-cache';
import { getSmartFlow } from '../solution-source/solution-source';
import { type SolutionGroupId, type SolutionId, type WorkerAddress } from '../polkadot/polka';

type EWX_ENVS =
  | 'EWX_SOLUTION'
  | 'EWX_SOLUTION_ID'
  | 'EWX_SOLUTION_GROUP_ID'
  | 'EWX_WORKLOGIC_ID'
  | 'EWX_RPC_URL'
  | 'BASE_URL'
  | 'EWX_SQLITE_PATH'
  | 'EWX_WORKER_ADDRESS';

const redLogger = createLogger('NodeRed');

export const startRedServer = async (app: express.Express): Promise<void> => {
  const loggerConfig = {
    console: {
      level: 'off',
      metrics: false,
      audit: false,
    },
    fileLogger: {
      level: 'info',
      metrics: true,
      handler: function () {
        const logger = createLogger({
          name: 'NodeRedServer',
          customLevels: NODE_RED_LOG_LEVELS,
          levelComparison: 'DESC',
        });

        return function (msg: {
          level: number;
          msg: string;
          z?: string;
          type?: string;
          id?: string;
        }) {
          const logLevel: string | undefined = REVERSED_NODE_RED_LOG_LEVELS[msg.level];

          const cached: string | undefined = getNodeRedSolutionNamespace(msg.z);

          if (logLevel === '' || logLevel == null) {
            console.error('missing log level ' + msg.level);
            console.error(msg);

            return;
          }

          if (MAIN_CONFIG.PRETTY_PRINT) {
            logger.info(
              {
                logLevel,
              },
              msg.msg,
            );

            return;
          }

          if (cached != null) {
            logger[logLevel](
              { solutionNamespace: cached, flow: msg.z, type: msg.type, id: msg.id },
              msg.msg,
            );
          } else {
            logger[logLevel]({}, msg.msg);
          }
        };
      },
    },
  };

  app.use('/', express.static('public'));

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = http.createServer(app);

  const functionGlobalContext = {
    rpcUrl: MAIN_CONFIG.PALLET_RPC_URL,
  };

  rmSync(MAIN_CONFIG.RED_DIRECTORY, {
    recursive: true,
    force: true,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings: any = {
    userDir: MAIN_CONFIG.RED_DIRECTORY,
    httpAdminRoot: MAIN_CONFIG.RED_ENABLE_UI ? '/red' : (false as const),
    httpNodeRoot: '/api',
    uiPort: MAIN_CONFIG.PORT,
    functionGlobalContext,
    uiHost: MAIN_CONFIG.HOST,
    logging: loggerConfig,
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  RED.init(server, settings);

  await RED.start();

  await runtimeStarted(20);

  redLogger.info('runtime started');

  if (MAIN_CONFIG.RED_ENABLE_UI) {
    app.use(settings.httpAdminRoot, RED.httpAdmin);
  }

  app.use(settings.httpNodeRoot, RED.httpNode);

  const port: number = MAIN_CONFIG.PORT;

  server.listen(port, function () {
    redLogger.info(`Node-RED and Dashboard UI running on http://localhost:${port}`);

    redLogger.info(`To access UI panel visit http://localhost:${port}/red`);
  });
};

export const runtimeStarted = async (maxAttempts: number = 10): Promise<boolean> => {
  let runtimeStarted = false;
  let attempts = 1;

  while (!runtimeStarted) {
    if (maxAttempts <= attempts) {
      redLogger.error(
        {
          maxAttempts,
          attempts,
        },
        `exceeded max attempts of runtime start`,
      );

      throw new Error('Unable to check if runtime started');
    }

    // Hacky way of testing if runtime is started - if it returns null, it means runtime has not started
    // if it returns anything else, it means that it started
    const flows = await RED.runtime.flows.getFlows({}).catch((e: Error) => {
      if (e?.message === "Cannot read properties of undefined (reading 'log')") {
        return null;
      }

      throw e;
    });

    runtimeStarted = flows !== null;

    await sleep(1000);

    attempts += 1;
  }

  return runtimeStarted;
};

export const upsertSolution = async (
  solutionGroupId: SolutionGroupId,
  solutionId: SolutionId,
  solution: object,
  worklogicId: string,
  excludedNodes: string[],
  workerAddress: WorkerAddress,
): Promise<void> => {
  const derivedLogger = redLogger.child({
    solutionId,
    solutionGroupId,
    worklogicId,
  });

  const existingSolution: RedNode | undefined = await getInstalledSolution(solutionId);

  if (
    existingSolution != null &&
    getNodeEnv(existingSolution, 'EWX_WORKLOGIC_ID') !== worklogicId
  ) {
    derivedLogger.info(
      {
        oldWorkLogic: existingSolution.workLogic,
        newWorkLogic: worklogicId,
      },
      `solution content has changed`,
    );

    await deleteNodeById(existingSolution.id);
  }

  if (
    existingSolution != null &&
    getNodeEnv(existingSolution, 'EWX_WORKLOGIC_ID') === worklogicId
  ) {
    return;
  }

  const content: string | null = await getSmartFlow(worklogicId, derivedLogger);

  if (content == null) {
    derivedLogger.error(`something is wrong with flow json file`);

    return;
  }

  const [basePath, sqliteFilePath]: [string, string] = buildSqlitePath(
    solutionId,
    solutionGroupId,
    workerAddress,
  );

  mkdirSync(basePath, { recursive: true });

  const parsedContent: {
    nodes: any[];
    id?: string;
    info?: string;
    label?: string;
    versionId?: string;
    env?: any[];
    configs?: any[];
  } = JSON.parse(content);

  const parsedFlow: ParsedFlow = modifyFlowIds(
    parsedContent,
    solutionGroupId,
    solutionId,
    solution,
    worklogicId,
    sqliteFilePath,
    workerAddress,
  );

  if (parsedFlow === null) {
    derivedLogger.error({ solutionId, solutionGroupId }, 'invalid flow, stopping install');

    return;
  }

  if (hasExcludedNodes(parsedFlow, excludedNodes)) {
    derivedLogger.warn({ excludedNodes }, `solution has excluded nodes`);

    return;
  }

  derivedLogger.info('installing solution');

  await RED.runtime.flows.addFlow({ flow: parsedFlow });

  derivedLogger.info('solution installed');
};
export const getInstalledSolution = async (
  solutionId: SolutionId,
): Promise<RedNode | undefined> => {
  const tabNodes: RedNodes = await getTabNodes();

  return tabNodes.find((tabNode) => tabNode.label === solutionId);
};

export const getNodeEnv = (
  node: RedNode,
  key: EWX_ENVS,
  throwOnError = true,
): string | undefined => {
  if (node.env == null) {
    node.env = [];
  }

  const envMeta = node.env.find((x) => x.name === key);

  if (envMeta == null && throwOnError) {
    throw new Error(`${key} not found in ${node.id}`);
  } else if (envMeta == null && !throwOnError) {
    return undefined;
  }

  return envMeta.value;
};

export const getSolutionNamespace = async (noderedId: string): Promise<string | null> => {
  const tabNode = await getTabNodes().then((tabNodes) =>
    tabNodes.find((node) => node.id === noderedId),
  );

  if (tabNode == null) {
    return null;
  }

  return getNodeEnv(tabNode, 'EWX_SOLUTION_ID', false) ?? null;
};

export const getSolutionLogicalParts = async (
  noderedId: string,
): Promise<{ solutionNamespace: string; solutionGroupId: string } | null> => {
  const tabNode = await getTabNodes().then((tabNodes) =>
    tabNodes.find((node) => node.id === noderedId),
  );

  if (tabNode == null) {
    return null;
  }

  const solutionNamespace: string | null = getNodeEnv(tabNode, 'EWX_SOLUTION_ID', false) ?? null;
  const solutionGroupId: string | null =
    getNodeEnv(tabNode, 'EWX_SOLUTION_GROUP_ID', false) ?? null;

  if (
    solutionNamespace === '' ||
    solutionNamespace == null ||
    solutionGroupId == null ||
    solutionGroupId === ''
  ) {
    return null;
  }

  return {
    solutionNamespace,
    solutionGroupId,
  };
};

export const deleteNodeById = async (tabNodeId: string): Promise<void> => {
  redLogger.info({ tabNodeId }, `deleting tab node`);

  await RED.runtime.flows.deleteFlow({ id: tabNodeId });
};

export const deleteAll = async (): Promise<void> => {
  redLogger.info(`removing all solutions`);

  const tabNodeIds: string[] = await getTabNodes().then((r) => r.map((x) => x.id));

  redLogger.info(`solutions to drop`, { tabNodeIds });

  for (const nodeId of tabNodeIds) {
    await RED.runtime.flows.deleteFlow({ id: nodeId });
  }
};

export const deleteNodesBySolutionGroupId = async (solutionGroupIds: string[]): Promise<void> => {
  redLogger.info({ solutionGroupIds }, `deleting flows based on solution group ids`);

  const tabNodes: RedNodes = await getTabNodes().then((nodes) =>
    nodes.filter((n) => {
      const solutionGroupId: string | undefined = getNodeEnv(n, 'EWX_SOLUTION_GROUP_ID');

      if (solutionGroupId == null) {
        return true;
      }

      return solutionGroupIds.includes(solutionGroupId);
    }),
  );

  for (const { id } of tabNodes) {
    await RED.runtime.flows.deleteFlow({ id });
  }
};

export const getAllInstalledSolutionsNames = async (): Promise<string[]> => {
  const tabNodes = await getTabNodes();

  const solutionIds: Array<string | null> = await Promise.all(
    tabNodes.map(async (tabNode: RedNode) => {
      const solutionId = getNodeEnv(tabNode, 'EWX_SOLUTION_ID', false);

      if (solutionId == null) {
        return null;
      }

      return solutionId;
    }),
  );

  return solutionIds.filter((x) => x !== null);
};

export const getTabNodes = async (): Promise<RedNodes> => {
  const currentFlows: Flows = await getAllFlows();

  if (currentFlows == null) {
    return [];
  }

  const nodes: RedNodes = currentFlows.flows as RedNodes;

  return nodes.filter((flow) => flow.type === 'tab');
};

export const getAllFlows = async (): Promise<Flows> => {
  return await RED.runtime.flows.getFlows({}).catch(() => {
    return { flows: [], rev: '' };
  });
};

const hasExcludedNodes = (parsedFlow: ParsedFlow, excludedNodes: string[]): boolean => {
  return excludedNodes.some(
    (rule) => parsedFlow.nodes.filter((node) => node.type.endsWith(rule)).length > 0,
  );
};

export const buildSqlitePath = (
  solutionId: SolutionId,
  solutionGroupId: SolutionGroupId,
  workerAddress: WorkerAddress,
): [string, string] => {
  const basePath: string = path.join(
    MAIN_CONFIG.SQLITE_BASE_PATH,
    workerAddress,
    solutionGroupId,
    solutionId,
  );

  return [basePath, path.join(basePath, 'db.sqlite')];
};

export const modifyFlowIds = (
  parsedFlow: {
    nodes: any[];
    id?: string;
    info?: string;
    label?: string;
    versionId?: string;
    env?: any[];
    configs?: any[];
  },
  solutionGroupId: SolutionGroupId,
  solutionId: SolutionId,
  solution: object,
  workLogic: string,
  sqlitePath: string,
  workerAddress: string,
): ParsedFlow | null => {
  if (parsedFlow?.nodes == null) {
    return null;
  }

  parsedFlow.id = RED.util.generateId();
  parsedFlow.info = solutionGroupId;
  parsedFlow.label = solutionId;
  parsedFlow.versionId = solutionId;

  const flowEwxEnvs: Array<{
    type: 'str';
    name: EWX_ENVS;
    value: string;
  }> = [
    {
      type: 'str',
      name: 'EWX_SOLUTION',
      value: JSON.stringify(solution),
    },
    {
      type: 'str',
      name: 'EWX_SOLUTION_ID',
      value: solutionId,
    },
    {
      type: 'str',
      name: 'EWX_SOLUTION_GROUP_ID',
      value: solutionGroupId,
    },
    {
      type: 'str',
      name: 'EWX_WORKLOGIC_ID',
      value: workLogic,
    },
    {
      type: 'str',
      name: 'EWX_SQLITE_PATH',
      value: sqlitePath,
    },
    {
      type: 'str',
      name: 'EWX_WORKER_ADDRESS',
      value: workerAddress,
    },
    {
      type: 'str',
      name: 'BASE_URL',
      value: MAIN_CONFIG.BASE_URLS,
    },
    {
      type: 'str',
      name: 'EWX_RPC_URL',
      value: MAIN_CONFIG.PALLET_RPC_URL,
    },
  ];

  parsedFlow.env = flowEwxEnvs;

  if (parsedFlow.configs != null) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    parsedFlow.nodes.push(...parsedFlow.configs);
  } else {
    parsedFlow.configs = [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsedFlow.configs = parsedFlow.configs.map((configContent: any) => {
    return {
      ...configContent,
      __envConfig: {
        EWX_SOLUTION_ID: solutionId,
        EWX_SOLUTION_GROUP_ID: solutionGroupId,
        EWX_WORKLOGIC_ID: workLogic,
        EWX_SQLITE_PATH: sqlitePath,
        EWX_WORKER_ADDRESS: workerAddress,
        EWX_RPC_URL: MAIN_CONFIG.PALLET_RPC_URL,
        BASE_URL: MAIN_CONFIG.BASE_URLS,
      },
    };
  });

  parsedFlow.nodes = parsedFlow.nodes.map((nodeContent: any) => {
    return {
      ...nodeContent,
      __envConfig: {
        EWX_SOLUTION_ID: solutionId,
        EWX_SOLUTION_GROUP_ID: solutionGroupId,
        EWX_WORKLOGIC_ID: workLogic,
        EWX_SQLITE_PATH: sqlitePath,
        EWX_WORKER_ADDRESS: workerAddress,
        EWX_RPC_URL: MAIN_CONFIG.PALLET_RPC_URL,
        BASE_URL: MAIN_CONFIG.BASE_URLS,
      },
    };
  });

  const uniqueIds = new Set<string>(parsedFlow.nodes.map((f) => f.id));
  const uniqueZs = new Set<string>(parsedFlow.nodes.map((f) => f.z));

  uniqueZs.forEach((z) => {
    uniqueIds.add(z);
    parsedFlow.id = z;
  });

  let tempJson = JSON.stringify(parsedFlow);

  uniqueIds.forEach((fe) => {
    if (fe != null) {
      tempJson = tempJson.replace(new RegExp(fe, 'g'), RED.util.generateId());
    }
  });
  parsedFlow = JSON.parse(tempJson);

  return parsedFlow;
};
