import { type ApiPromise } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
import {
  deleteNodeById,
  deleteNodesBySolutionGroupId,
  getNodeEnv,
  getTabNodes,
  upsertSolution,
} from './node-red/red';
import { type Logger } from 'pino';
import { MAIN_CONFIG } from './config';
import { type NodeRedSolutionCache, setNodeRedSolutionCache } from './node-red/node-red-cache';
import {
  getCurrentBlock,
  getOperatorAddress,
  getOperatorSubscriptions,
  getSolutionGroupsByIds,
  getSolutions,
  type OperatorAddress,
  queryStake,
  type QueryStakeResult,
  retryHttpAsyncCall,
  type SolutionArray,
  type SolutionGroupId,
} from './polkadot/polka';
import { type SolutionGroup } from './polkadot/polka-types';
import { sleep } from './util/sleep';
import { createLogger } from './util/logger';
import { createReadPalletApi } from './util/pallet-api';
import { type RedNode, type RedNodes } from './node-red/types';

const logger = createLogger('SolutionLoop');

export const pushToQueue = async (account: KeyringPair): Promise<void> => {
  // eslint-disable-next-line no-constant-condition

  const timeout: number = MAIN_CONFIG.SOLUTION_QUEUE_PROCESS_DELAY;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const api: ApiPromise = await retryHttpAsyncCall(async () => await createReadPalletApi());

      await processSolutionQueue(api, account).catch(async (e) => {
        logger.error('failed to complete queue loop');
        logger.error(e);

        await sleep(50000);
        await pushToQueue(account);
        await api.disconnect();
      });

      await api.disconnect();
      await sleep(timeout);
    } catch (e) {
      logger.error('Critical error in pushToQueue loop, retrying in 50s');
      logger.error(e);
      await sleep(50000);
    }
  }
};

const setNodeRedCache = (tabNodes: RedNodes): void => {
  const cached = tabNodes.reduce<NodeRedSolutionCache>((acc, curr) => {
    if (curr.label == null) {
      return acc;
    }

    acc[curr.id] = curr.label ?? 'NodeRedServer';

    return acc;
  }, {});

  setNodeRedSolutionCache(cached);
};

async function processSolutionQueue(api: ApiPromise, workerAccount: KeyringPair): Promise<void> {
  logger.info(`attempting to process solutions`);

  const operatorAddress: string | null = await getOperatorAddress(api, workerAccount.address);

  if (operatorAddress == null) {
    logger.info({ workerAddress: workerAccount.address }, 'no operator assigned to worker');

    await sleep(5000);

    return;
  }

  const operatorSubscriptions: string[] = await getOperatorSubscriptions(api, operatorAddress);

  if (operatorSubscriptions.length === 0) {
    await sleep(5000);

    return;
  }

  const solutionGroups: Record<SolutionGroupId, SolutionGroup> = await getSolutionGroupsByIds(
    api,
    operatorSubscriptions,
  );

  logger.info({ operatorSubscriptions, operatorAddress }, `found operator subscriptions`);

  const tabNodes: RedNodes = await getTabNodes();

  const tabNodesWithoutUnsubscribedSolutionGroups: RedNodes = await dropUnsubscribedGroups(
    tabNodes,
    operatorSubscriptions,
  );

  const unfilteredSolutions: SolutionArray = await getSolutions(api, operatorSubscriptions);

  const solutions: SolutionArray = unfilteredSolutions.filter((solution) =>
    operatorSubscriptions.includes(solution[1]),
  );

  const solutionsWithoutSubscribedSolutionGroup = unfilteredSolutions.filter(
    (solution) => !operatorSubscriptions.includes(solution[1]),
  );

  const tabNodesWithoutInactiveSolutions: RedNodes = await dropInactiveSolutions(
    tabNodesWithoutUnsubscribedSolutionGroups,
    solutions,
  );

  const tabNodesWithoutInvalidSolutionGroups: RedNodes = await dropSolutionsWithoutSolutionGroup(
    tabNodesWithoutInactiveSolutions,
    solutionsWithoutSubscribedSolutionGroup,
    logger,
  );

  await dropUnsubscribedSolutions(
    tabNodesWithoutInvalidSolutionGroups,
    solutionsWithoutSubscribedSolutionGroup,
    logger,
  );

  const activeSolutions: SolutionArray = solutions.filter((x) => x[3] === 'Active');

  const targetSolutionNamespaces: string[] = MAIN_CONFIG.TARGET_SOLUTION_NAMESPACES ?? [];

  const activeTargetSolutions: SolutionArray =
    targetSolutionNamespaces.length === 0
      ? activeSolutions
      : activeSolutions.filter((x) => targetSolutionNamespaces.includes(x[0]));

  if (activeTargetSolutions.length === 0) {
    logger.info({ operatorSubscriptions, operatorAddress }, 'did not found any active solutions');

    await sleep(5000);

    return;
  }

  const solutionGroupStatus = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [_, solutionGroup] of Object.entries(solutionGroups)) {
    const hasValidConfiguration: boolean = await hasValidGroupConfiguration(
      api,
      operatorAddress,
      solutionGroup,
    );

    if (!hasValidConfiguration) {
      logger.warn(
        { solutionGroupId: solutionGroup.namespace },
        'operator does not meet criteria for solution group, skipping installation',
      );

      continue;
    }

    solutionGroupStatus.add(solutionGroup.namespace);
  }

  for (const solution of activeTargetSolutions) {
    const workLogic: string = solution[2].workload.workLogic;

    const fulfillsSolutionGroupCriteria = solutionGroupStatus.has(solution[1]);

    if (!fulfillsSolutionGroupCriteria) {
      logger.warn(
        {
          solutionId: solution[0],
          solutionGroupId: solution[1],
        },
        'solution is not going to be installed due to not meeting criteria',
      );

      continue;
    }

    await upsertSolution(
      solution[1],
      solution[0],
      solution[2],
      workLogic,
      MAIN_CONFIG.EXCLUDED_NODES,
      workerAccount.address,
    ).catch((e) => {
      logger.error(
        { solutionId: solution[0], solutionGroupId: solution[1] },
        `failed to upsert solution to node red`,
      );

      logger.error(e);
    });
  }

  const refreshedTabNodes: RedNodes = await getTabNodes();

  setNodeRedCache(refreshedTabNodes);

  await sleep(30000);
}

const hasValidGroupConfiguration = async (
  api: ApiPromise,
  operatorAddress: OperatorAddress,
  solutionGroup: SolutionGroup,
): Promise<boolean> => {
  const currentBlockNumber: number | null = await getCurrentBlock(api);

  if (currentBlockNumber == null) {
    logger.info(
      {
        solutionGroupId: solutionGroup.namespace,
      },
      'unable to receive current block number',
    );

    return false;
  }

  const startingBlock = BigInt(solutionGroup.operationStartBlock);

  if (startingBlock >= currentBlockNumber) {
    logger.info(
      {
        startingBlock,
        currentBlockNumber,
        solutionGroupId: solutionGroup.namespace,
      },
      'solution does not allow voting yet',
    );

    return false;
  }

  const hasStake: QueryStakeResult = await queryStake(
    api,
    operatorAddress,
    solutionGroup.namespace,
  );

  if (hasStake.currentStake < BigInt(solutionGroup.operatorsConfig.stakingAmounts.min)) {
    logger.info(
      {
        requiredMinimalStakingAmount: BigInt(solutionGroup.operatorsConfig.stakingAmounts.min),
        currentStake: hasStake.currentStake,
        solutionGroupId: solutionGroup.namespace,
      },
      'operator has no stake',
    );

    return false;
  }

  return true;
};

const dropSolutionsWithoutSolutionGroup = async (
  tabNodes: RedNodes,
  solutions: SolutionArray,
  logger: Logger,
): Promise<RedNodes> => {
  const deletedEmptySolutions: string[] = [];

  for (const [solutionId, solutionGroupId, ,] of solutions) {
    if (solutionGroupId == null) {
      const tabNode = tabNodes.find((x) => getNodeEnv(x, 'EWX_SOLUTION_ID') === solutionId);

      if (tabNode == null) {
        continue;
      }

      await deleteNodeById(tabNode.id);

      deletedEmptySolutions.push(solutionId);
    }
  }

  if (deletedEmptySolutions.length > 0) {
    logger.info(
      {
        deletedEmptySolutions,
      },
      `deleted solutions without solution group`,
    );
  }

  return await getTabNodes();
};

const dropUnsubscribedSolutions = async (
  tabNodes: RedNodes,
  solutions: SolutionArray,
  logger: Logger,
): Promise<RedNodes> => {
  const installedSolutionIds: string[] = [
    ...new Set(tabNodes.map((x) => getNodeEnv(x, 'EWX_SOLUTION_ID'))),
  ].filter((x) => x != null);

  const deletedSolutionsIds: string[] = [];

  for (const installedSolutionId of installedSolutionIds) {
    const matchingSolution = solutions.find((x) => x[0] === installedSolutionId);

    if (matchingSolution == null) {
      continue;
    }

    const tabNode: RedNode | undefined = tabNodes.find((t) => getNodeEnv(t, 'EWX_SOLUTION_ID'));

    if (tabNode == null) {
      continue;
    }

    const solutionInstalledSolutionGroupId = getNodeEnv(tabNode, 'EWX_SOLUTION_GROUP_ID');

    if (solutionInstalledSolutionGroupId == null) {
      await deleteNodeById(tabNode.id);
    }

    if (solutionInstalledSolutionGroupId !== matchingSolution[1]) {
      await deleteNodeById(tabNode.id);
    }
  }

  if (deletedSolutionsIds.length > 0) {
    logger.info(
      {
        deletedSolutionsIds,
      },
      'removed unsubscribed solutions',
    );
  }

  return await getTabNodes();
};

const dropInactiveSolutions = async (
  tabNodes: RedNodes,
  solutions: SolutionArray,
): Promise<RedNodes> => {
  const inactiveSolutions: SolutionArray = solutions.filter((s) => s[3] !== 'Active');

  logger.info(
    {
      inactiveSolutions: inactiveSolutions.map((x) => x[0]),
    },
    `dropping inactive solutions`,
  );

  for (const solution of inactiveSolutions) {
    const tabNode: RedNode | undefined = tabNodes.find((t) => t.label === solution[0]);

    if (tabNode == null) {
      continue;
    }

    await deleteNodeById(tabNode.id);
  }

  return await getTabNodes();
};

const dropUnsubscribedGroups = async (
  tabNodes: RedNodes,
  operatorSubscriptions: string[],
): Promise<RedNodes> => {
  const installedSolutionGroupTabsIds: string[] = [
    ...new Set(tabNodes.map((x) => getNodeEnv(x, 'EWX_SOLUTION_GROUP_ID'))),
  ].filter((x) => x != null);

  const unsubscribedSolutionGroupsIds: string[] = installedSolutionGroupTabsIds.filter(
    (element) => !operatorSubscriptions.includes(element),
  );

  if (unsubscribedSolutionGroupsIds.length === 0) {
    return await getTabNodes();
  }

  logger.info({ unsubscribedSolutionGroupsIds }, `dropping unsubscribed solution groups`);

  await deleteNodesBySolutionGroupId(unsubscribedSolutionGroupsIds);

  return await getTabNodes();
};
