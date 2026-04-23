import { type ApiPromise } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
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
import { ALL_RUNTIMES, getLocalFlowOverride, pickRuntimeForSolution } from './runtime/registry';
import { type InstalledSolutionHandle, type Runtime } from './runtime/runtime';
import { getSmartFlow } from './solution-source/solution-source';
import {
  solutionGroupCache,
  solutionNameCache,
  SOLUTION_GROUP_NAME_CACHE_TTL_MS,
} from './util/operator-info';

const logger = createLogger('SolutionLoop');

export const pushToQueue = async (account: KeyringPair): Promise<void> => {
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

/**
 * Refresh the NR-side logger cache so NR-origin log lines can be tagged with
 * the solution namespace they belong to. Skipped for other runtimes because
 * their logs flow through their own pipes.
 */
const refreshNodeRedCache = async (): Promise<void> => {
  const nr: Runtime | undefined = ALL_RUNTIMES.find((r) => r.id === 'node-red');

  if (nr == null) return;

  const handles: InstalledSolutionHandle[] = await nr.getInstalledSolutionHandles();
  const cached = handles.reduce<NodeRedSolutionCache>((acc, h) => {
    if (h.solutionId != null) {
      acc[h.runtimeInternalId] = h.solutionId;
    }

    return acc;
  }, {});

  setNodeRedSolutionCache(cached);
};

interface HandleWithRuntime extends InstalledSolutionHandle {
  runtime: Runtime;
}

/**
 * Collect installed-solution handles from every registered runtime in one go.
 * The drop-* helpers operate across all runtimes so a solution can migrate
 * between runtimes on chain and the old-runtime installation is cleaned up.
 */
const getAllInstalledHandles = async (): Promise<HandleWithRuntime[]> => {
  const out: HandleWithRuntime[] = [];

  for (const rt of ALL_RUNTIMES) {
    const handles: InstalledSolutionHandle[] = await rt.getInstalledSolutionHandles();

    for (const h of handles) {
      out.push({ ...h, runtime: rt });
    }
  }

  return out;
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

  for (const [id, group] of Object.entries(solutionGroups)) {
    if (group?.info?.name != null && group.info.name !== '') {
      await solutionGroupCache.set(id, group.info.name, SOLUTION_GROUP_NAME_CACHE_TTL_MS);
    }
  }

  logger.info({ operatorSubscriptions, operatorAddress }, `found operator subscriptions`);

  let installedHandles: HandleWithRuntime[] = await getAllInstalledHandles();

  await dropUnsubscribedGroups(installedHandles, operatorSubscriptions);

  const unfilteredSolutions: SolutionArray = await getSolutions(api, operatorSubscriptions);

  for (const [solutionId, , solutionObj] of unfilteredSolutions) {
    if (solutionObj?.info?.name != null && solutionObj.info.name !== '') {
      await solutionNameCache.set(
        solutionId,
        solutionObj.info.name,
        SOLUTION_GROUP_NAME_CACHE_TTL_MS,
      );
    }
  }

  const solutions: SolutionArray = unfilteredSolutions.filter((solution) =>
    operatorSubscriptions.includes(solution[1]),
  );

  const solutionsWithoutSubscribedSolutionGroup: SolutionArray = unfilteredSolutions.filter(
    (solution) => !operatorSubscriptions.includes(solution[1]),
  );

  installedHandles = await getAllInstalledHandles();
  await dropInactiveSolutions(installedHandles, solutions);

  installedHandles = await getAllInstalledHandles();
  await dropSolutionsWithoutSolutionGroup(
    installedHandles,
    solutionsWithoutSubscribedSolutionGroup,
    logger,
  );

  installedHandles = await getAllInstalledHandles();
  await dropUnsubscribedSolutions(
    installedHandles,
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

  // Precompute which solution groups have a valid configuration, so we can
  // cheaply filter out solutions belonging to a group that doesn't qualify.
  const solutionGroupStatus = new Set<string>();

  for (const solutionGroup of Object.values(solutionGroups)) {
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

  // Refresh once more so cross-runtime migration logic below sees latest state.
  installedHandles = await getAllInstalledHandles();

  for (const solution of activeTargetSolutions) {
    const solutionId: string = solution[0];
    const solutionGroupId: string = solution[1];
    const solutionBody = solution[2];
    const workLogic: string = solutionBody.workload.workLogic;

    if (!solutionGroupStatus.has(solutionGroupId)) {
      logger.warn(
        { solutionId, solutionGroupId },
        'solution is not going to be installed due to not meeting criteria',
      );

      continue;
    }

    const runtime: Runtime | null = pickRuntimeForSolution(solutionId, solutionBody);

    if (runtime == null) {
      // pickRuntimeForSolution already logged the reason.
      continue;
    }

    // If this solution is installed in a different runtime (because the chain
    // flipped its executionEnvironment, or DEV_RUNTIME_OVERRIDES changed
    // between boots), remove it from the old runtime before installing fresh.
    const current = installedHandles.find((h) => h.solutionId === solutionId);

    if (current != null && current.runtime.id !== runtime.id) {
      logger.info(
        { solutionId, oldRuntime: current.runtime.id, newRuntime: runtime.id },
        'solution migrated between runtimes; removing from old runtime',
      );

      await current.runtime.deleteBySolutionId(solutionId);
    }

    // Flow content: DEV_LOCAL_FLOW_OVERRIDES wins for iteration-friendly dev,
    // otherwise fetch via the normal IPFS/local pipeline.
    const derivedLogger = logger.child({ solutionId, solutionGroupId, worklogicId: workLogic });

    let flowContent: string | null = getLocalFlowOverride(solutionId);

    if (flowContent != null) {
      derivedLogger.info('using DEV_LOCAL_FLOW_OVERRIDES for flow content');
    } else {
      flowContent = await getSmartFlow(workLogic, derivedLogger);
    }

    if (flowContent == null) {
      derivedLogger.error('no flow content available for solution; skipping');

      continue;
    }

    await runtime
      .upsertSolution({
        solutionGroupId,
        solutionId,
        solution: solutionBody,
        workLogicId: workLogic,
        excludedNodes: MAIN_CONFIG.EXCLUDED_NODES,
        workerAddress: workerAccount.address,
        flowContent,
      })
      .catch((e: Error) => {
        logger.error(
          { solutionId, solutionGroupId, runtime: runtime.id },
          `failed to upsert solution to ${runtime.id}`,
        );
        logger.error(e);
      });
  }

  await refreshNodeRedCache();

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
      { solutionGroupId: solutionGroup.namespace },
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

/**
 * Remove installations whose on-chain solutionGroupId is not currently
 * subscribed by this operator. Applied per-runtime so every runtime's state
 * is reconciled.
 */
const dropUnsubscribedGroups = async (
  installedHandles: HandleWithRuntime[],
  operatorSubscriptions: string[],
): Promise<void> => {
  const uniqueGroupIds: string[] = [
    ...new Set(
      installedHandles.map((h) => h.solutionGroupId).filter((g): g is string => g != null),
    ),
  ];

  const unsubscribed: string[] = uniqueGroupIds.filter((g) => !operatorSubscriptions.includes(g));

  if (unsubscribed.length === 0) return;

  logger.info({ unsubscribedSolutionGroupsIds: unsubscribed }, `dropping unsubscribed groups`);

  for (const rt of ALL_RUNTIMES) {
    await rt.deleteNodesBySolutionGroupId(unsubscribed);
  }
};

/** Remove installations for on-chain solutions that are no longer Active. */
const dropInactiveSolutions = async (
  installedHandles: HandleWithRuntime[],
  solutions: SolutionArray,
): Promise<void> => {
  const inactive: SolutionArray = solutions.filter((s) => s[3] !== 'Active');

  if (inactive.length === 0) return;

  logger.info({ inactiveSolutions: inactive.map((x) => x[0]) }, `dropping inactive solutions`);

  for (const solution of inactive) {
    const solutionId: string = solution[0];
    const handle = installedHandles.find((h) => h.solutionId === solutionId);

    if (handle == null) continue;

    await handle.runtime.deleteBySolutionId(solutionId);
  }
};

/**
 * Remove installations whose on-chain solution has no solutionGroupId
 * configured (a known edge case).
 */
const dropSolutionsWithoutSolutionGroup = async (
  installedHandles: HandleWithRuntime[],
  solutions: SolutionArray,
  logger: Logger,
): Promise<void> => {
  const deleted: string[] = [];

  for (const [solutionId, solutionGroupId] of solutions) {
    if (solutionGroupId != null) continue;

    const handle = installedHandles.find((h) => h.solutionId === solutionId);

    if (handle == null) continue;

    await handle.runtime.deleteBySolutionId(solutionId);
    deleted.push(solutionId);
  }

  if (deleted.length > 0) {
    logger.info({ deletedEmptySolutions: deleted }, `deleted solutions without solution group`);
  }
};

/**
 * Remove installations whose solutionGroupId on the chain differs from what
 * the installed instance has recorded, meaning the solution was moved to a
 * different group since our last reconcile.
 */
const dropUnsubscribedSolutions = async (
  installedHandles: HandleWithRuntime[],
  solutions: SolutionArray,
  logger: Logger,
): Promise<void> => {
  const deleted: string[] = [];

  for (const handle of installedHandles) {
    if (handle.solutionId == null || handle.solutionGroupId == null) continue;

    const matching = solutions.find((s) => s[0] === handle.solutionId);

    if (matching == null) continue;

    if (matching[1] !== handle.solutionGroupId) {
      await handle.runtime.deleteBySolutionId(handle.solutionId);
      deleted.push(handle.solutionId);
    }
  }

  if (deleted.length > 0) {
    logger.info({ deletedSolutionsIds: deleted }, 'removed unsubscribed solutions');
  }
};
