import { ApiPromise, HttpProvider } from '@polkadot/api';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';
import { Tuple, u128, u32 } from '@polkadot/types-codec';
import { type KeyringPair } from '@polkadot/keyring/types';
import { type Solution, type SolutionGroup } from './polka-types';
import pino from 'pino';
import { stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import promiseRetry from 'promise-retry';
import { type WrapOptions } from 'retry';
import { sleep } from '../util';

export type WorkerAddress = string;
export type OperatorAddress = string;
export type SolutionGroupId = string;
export type SolutionId = string;
export type SolutionStatus = string;

export type SolutionArray = Array<[SolutionId, SolutionGroupId, Solution, SolutionStatus]>;

export interface QueryStakeResult {
  period: bigint;
  currentStake: bigint;
  nextStake: bigint;
}

const polkaLogger = pino({
  name: 'PolkaLogger',
});

export const createApi = async (palletEndpoint: string): Promise<ApiPromise> => {
  const api: ApiPromise = await ApiPromise.create({
    provider: new HttpProvider(palletEndpoint),
    types: { QueryResult: Tuple.with([u32, u128, u128]) },
    noInitWarn: true,
    throwOnConnect: true,
  });

  await api.isReady;

  await cryptoWaitReady();

  return api;
};

export const retryHttpAsyncCall = async <T>(
  call: () => Promise<T>,
  retryOptions: WrapOptions = {
    forever: true,
    minTimeout: 1000,
    maxTimeout: 2000,
    randomize: true,
  },
): Promise<T> => {
  return await promiseRetry(async (retry) => {
    try {
      return await call();
    } catch (e) {
      if(e.message === 'FATAL: Unable to initialize the API: [502]: Bad Gateway') {
        return retry(e);
      }

      if (e.message === 'FATAL: Unable to initialize the API: fetch failed') {
        return retry(e);
      }

      if (e instanceof TypeError && e.message === 'fetch failed') {
        return retry(e);
      }

      throw e;
    }
  }, retryOptions);
};

export const getCurrentBlock = async (api: ApiPromise): Promise<number | null> => {
  const signedBlock = await api.rpc.chain.getBlock().catch(() => undefined);

  if (signedBlock != null) {
    return signedBlock.block.header.number.toNumber();
  }

  return null;
};

export const getSolutionGroupsByIds = async (
  api: ApiPromise,
  requestedSolutionGroups: string[],
): Promise<Record<SolutionGroupId, SolutionGroup>> => {
  const solutionGroups =
    await api.query.workerNodePallet.solutionsGroups.multi(requestedSolutionGroups);

  return solutionGroups.reduce((acc, curr) => {
    const primitive: SolutionGroup | undefined | null =
      curr.toPrimitive() as unknown as SolutionGroup;

    if (primitive == null) {
      throw new Error('Unable to decode codec for Solution Group');
    }

    acc[primitive.namespace] = primitive;

    return acc;
  }, {});
};

export const getSolutions = async (api: ApiPromise): Promise<SolutionArray> => {
  const solutions = await api.query.workerNodePallet.solutions.entries();

  const results: SolutionArray = await Promise.all(
    solutions.map(async ([namespaceHash, solution]) => {
      const solutionId: string = (namespaceHash.toHuman() as unknown as SolutionId[])[0];

      const solutionPrimitive = solution.toPrimitive() as unknown as Solution;

      const groupOfSolution = await api.query.workerNodePallet.groupOfSolution(solutionId);

      const solutionGroupId: string | null =
        groupOfSolution.toPrimitive() as unknown as SolutionGroupId;

      return [solutionId, solutionGroupId, solutionPrimitive, solutionPrimitive.status];
    }),
  );

  return results.filter((s) => s != null).filter((s) => s !== null);
};

export const isConnectedAsWorker = async (
  api: ApiPromise,
  address: WorkerAddress,
): Promise<[boolean, OperatorAddress | null]> => {
  const encodedAccount = api.registry.createType('AccountId', address);

  const result = await api.query.workerNodePallet.workerNodeToOperator(encodedAccount);

  const humanizedResult: string | null = result.toHuman() as string | null;

  return [humanizedResult != null, humanizedResult];
};

export const getOperatorAddress = async (
  api: ApiPromise,
  workerAddress: WorkerAddress,
): Promise<string | null> => {
  const operatorAddress = await api.query.workerNodePallet.workerNodeToOperator(workerAddress);

  return operatorAddress.toString();
};

export const getOperatorSubscriptions = async (
  api: ApiPromise,
  address: OperatorAddress,
): Promise<string[]> => {
  polkaLogger.info({ address }, `fetching operator subscriptions`);

  const encodedAccount = api.registry.createType('AccountId', address);

  const operatorSubscriptions = await api.query.workerNodePallet.operatorSubscriptions.entries(
    encodedAccount.toU8a(true),
  );

  return operatorSubscriptions
    .map(([c, _]) => c.toHuman() as unknown as [string, string])
    .map(([_, solutionGroupId]) => solutionGroupId);
};

export const submitSolutionResult = async (
  api: ApiPromise,
  account: KeyringPair,
  namespace: string,
  nodeHash: string,
  votingRoundId: string,
  loopTimeMiliseconds = 3000,
): Promise<string | null> => {
  const resultHash = blake2AsHex(nodeHash);
  const signature = account.sign(resultHash);

  const utx = api.tx.workerNodePallet.submitSolutionResult(
    namespace,
    votingRoundId,
    resultHash,
    signature,
    account.publicKey,
  );

  const transactionHash: string | null = await new Promise(
    // eslint-disable-next-line no-async-promise-executor,@typescript-eslint/no-misused-promises
    async (resolve, reject) => {
      let counter = 0;
      let check = true;
      const BLOCK_HEADER_MAX: number = 12 * 5;

      await utx
        .send(async (data) => {
          while (check) {
            if (counter >= BLOCK_HEADER_MAX) {
              resolve(null);
            }

            const signedBlock = await api.rpc.chain.getBlock().catch(() => undefined);

            if (signedBlock == null) {
              continue;
            }

            const lastHdr = signedBlock.block.header;
            const extrinsicHash = data.toHuman();

            await Promise.allSettled(
              signedBlock.block.extrinsics.map(async (ex) => {
                if (extrinsicHash === ex.hash.toHex()) {
                  resolve(lastHdr.hash.toHex());

                  check = false;
                }
              }),
            );
            await sleep(loopTimeMiliseconds);

            counter = counter + 1;
          }
        })
        .catch((e) => {
          reject(e);
        });
    },
  );

  return transactionHash;
};

export const queryStake = async (
  api: ApiPromise,
  operatorAddress: OperatorAddress,
  solutionGroupId: SolutionGroupId,
): Promise<QueryStakeResult> => {
  const encodedAddress = api.registry.createType('AccountId', operatorAddress);
  const encodedGroupId = api.registry.createType('Vec<u8>', u8aToHex(stringToU8a(solutionGroupId)));
  const encodedData = u8aConcat(encodedAddress.toU8a(true), encodedGroupId.toU8a(false));

  const data = u8aToHex(encodedData);

  const encodedStake = await api.rpc.state.call('WorkerSolutionApi_query_stake', data);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  const [period, currentStake, nextStake]: [string, string, string] = api.registry.createType(
    'QueryResult',
    encodedStake,
  );

  if (currentStake == null || period == null || nextStake == null) {
    throw new Error('unable to obtain stake');
  }

  return {
    currentStake: BigInt(currentStake.toString()),
    nextStake: BigInt(nextStake.toString()),
    period: BigInt(period.toString()),
  };
};
