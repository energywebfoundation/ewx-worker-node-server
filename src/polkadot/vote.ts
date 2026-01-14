import { Keyring } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
import type { queueAsPromised } from 'fastq';
import * as fastq from 'fastq';
import { createLogger } from '../util/logger';
import { createEwxTxManager } from '../util/ewx-tx-manager';
import { sleep } from '../util/sleep';
import { MAIN_CONFIG } from '../config';
import { retryHttpAsyncCall, submitSolutionResult } from './polka';
import { createCache } from 'cache-manager';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const VOTE_STORAGE = createCache({
  ttl: ONE_DAY_MS,
});

interface VoteTask {
  votingRoundId: string;
  noderedId: string;
  vote: string;
  startedAt: number;
  solutionNamespace: string;
  voteIdentifier: string | null;
  hashVote: boolean;
}

export const voteQueue: queueAsPromised<VoteTask> = fastq.promise(asyncWorker, 4);

const ewxTxManager = createEwxTxManager();

const DELAY_TIMER: number = 30 * 1000;
const NINE_MINUTES = 540000;

export const voteQueueLogger = createLogger('VoteQueue');

voteQueue.error((error: Error | null, task: VoteTask) => {
  if (error == null) {
    return;
  }

  voteQueueLogger.error({ task }, 'unexpected vote queue error');
  voteQueueLogger.error(error);
});

async function asyncWorker(arg: VoteTask): Promise<void> {
  const tempLogger = createLogger({
    name: `Solution-Vote-${arg.solutionNamespace}`,
    base: arg,
  });

  try {
    if (Date.now() - arg.startedAt >= NINE_MINUTES) {
      tempLogger.warn('timeout passed for vote, abandoning it');

      return;
    }

    await processVoteQueue(arg);
  } catch (e) {
    tempLogger.error(`failed to submit vote`);
    tempLogger.error(e);

    if (e.toString() === 'TypeError: fetch failed') {
      await sleep(DELAY_TIMER);

      tempLogger.warn('attempting to retry vote');
      await voteQueue.push(arg);
    } else {
      tempLogger.warn('skipping vote, non-http error');
    }
  }
}

async function processVoteQueue(task: VoteTask): Promise<void> {
  const tempLogger = createLogger({
    name: `Solution-Vote-${task.solutionNamespace}`,
    base: task,
  });

  const keyring = new Keyring({ type: 'sr25519' });

  const account: KeyringPair = keyring.addFromMnemonic(MAIN_CONFIG.VOTING_WORKER_SEED);

  tempLogger.info('attempting to send vote');

  await retryHttpAsyncCall(
    async () =>
      await submitSolutionResult(
        ewxTxManager,
        account,
        task.solutionNamespace,
        task.vote,
        task.votingRoundId,
        task.hashVote,
      ),
  )
    .then(async (hash) => {
      if (task.voteIdentifier != null) {
        await VOTE_STORAGE.set(
          task.voteIdentifier,
          {
            createdAt: Date.now(),
            transactionHash: hash,
          },
          ONE_DAY_MS,
        );
      }

      tempLogger.info(
        {
          transactionHash: hash,
        },
        'submitted vote',
      );

      tempLogger.flush();
    })
    .catch(async (e) => {
      // EWX Error - (some) http errors are handled in retryHttpAsyncCall fn
      tempLogger.error(
        {
          task,
        },
        'failed to submit solution result - voting wont be retried',
      );
      tempLogger.error(e);
      tempLogger.flush();

      // We do not throw for these kind of errors so we can continue processing
    });
}

// Drains the vote queue, waiting for all pending and running tasks to complete.
export const drainVoteQueue = async (): Promise<void> => {
  voteQueueLogger.info(
    {
      pendingTasks: voteQueue.length(),
      runningTasks: voteQueue.running(),
    },
    'draining vote queue',
  );

  await voteQueue.drained();

  voteQueueLogger.info('vote queue drained successfully');
};
