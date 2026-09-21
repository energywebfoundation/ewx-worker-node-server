import axios from 'axios';
import { z } from 'zod';
import { type QueryStakeResult } from '../polkadot/polka';
import { createLogger } from './logger';
import { getBaseUrls } from './base-urls';
import { MAIN_CONFIG } from '../config';

const logger = createLogger('Indexer');

export const OperatorStakeSchema = z.object({
  data: z.object({
    operatorSubscribedStakes: z.array(
      z.object({
        currentStake: z.string().transform((val) => BigInt(val)),
        nextStake: z.string().transform((val) => BigInt(val)),
        rewardPeriodIndex: z.number().transform((val) => BigInt(val)),
      }),
    ),
  }),
});

export type OperatorStakeResponse = z.infer<typeof OperatorStakeSchema>;

export const SquidStatusSchema = z.object({
  data: z.object({
    squidStatus: z.object({
      finalizedHash: z.string(),
      finalizedHeight: z.number().transform((val) => BigInt(val)),
      hash: z.string(),
      height: z.number().transform((val) => BigInt(val)),
    }),
  }),
});

export type SquidStatusResponse = z.infer<typeof SquidStatusSchema>;

const GET_SQUID_STATUS_QUERY = `
  query GetSquidStatus {
    squidStatus {
      finalizedHash
      finalizedHeight
      hash
      height
    }
  }
`;

const GET_OPERATOR_STAKE_QUERY = `
  query GetOperatorStake($operatorAddress: String!, $solutionGroupId: String!) {
    operatorSubscribedStakes(
      where: {
        operator: { id_eq: $operatorAddress },
        solutionGroup: { namespace_eq: $solutionGroupId }
      },
      orderBy: rewardPeriodIndex_DESC,
      limit: 1
    ) {
      currentStake
      nextStake
      rewardPeriodIndex
    }
  }
`;

export const queryStakeFromIndexer = async (
  operatorAddress: string,
  solutionGroupId: string,
): Promise<QueryStakeResult | null> => {
  try {
    const baseUrls = await getBaseUrls();

    logger.info({ baseUrls, operatorAddress, solutionGroupId }, 'querying stake from indexer');

    const { data } = await axios.post<OperatorStakeResponse>(
      `${baseUrls.baseIndexerUrl}/core/graphql`,
      {
        query: GET_OPERATOR_STAKE_QUERY,
        variables: {
          operatorAddress,
          solutionGroupId,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    const parsed = OperatorStakeSchema.safeParse(data);

    if (!parsed.success) {
      logger.warn(
        { error: parsed.error.flatten(), operatorAddress, solutionGroupId },
        'indexer response failed validation',
      );
      return null;
    }

    const stakes = parsed.data.data.operatorSubscribedStakes;

    if (stakes.length > 0) {
      const stakeNode = stakes[0];
      return {
        currentStake: stakeNode.currentStake,
        nextStake: stakeNode.nextStake,
        period: stakeNode.rewardPeriodIndex,
      };
    }
    return null;
  } catch (error) {
    logger.warn({ error, operatorAddress, solutionGroupId }, 'failed to query stake from indexer');
    return null;
  }
};

export const isIndexerSynced = async (currentBlock: number): Promise<boolean> => {
  try {
    const baseUrls = await getBaseUrls();

    const { data } = await axios.post<SquidStatusResponse>(
      `${baseUrls.baseIndexerUrl}/core/graphql`,
      {
        query: GET_SQUID_STATUS_QUERY,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    const parsed = SquidStatusSchema.safeParse(data);

    if (!parsed.success) {
      logger.warn({ error: parsed.error.flatten() }, 'squid status response failed validation');
      return false;
    }

    const finalizedHeight = parsed.data.data.squidStatus.finalizedHeight;
    const buffer = BigInt(MAIN_CONFIG.INDEXER_SYNC_BUFFER_BLOCKS);
    const finalizedHeightWithBuffer = finalizedHeight + buffer;

    logger.info(
      { finalizedHeight, currentBlock, buffer, finalizedHeightWithBuffer },
      'indexer finalized height and current block',
    );

    return finalizedHeightWithBuffer >= BigInt(currentBlock);
  } catch (error) {
    logger.warn({ error }, 'failed to query squid status from indexer');
    return false;
  }
};
