import { Keyring } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
import express from 'express';
import asyncHandler from 'express-async-handler';
import type { queueAsPromised } from 'fastq';
import * as fastq from 'fastq';
import { z } from 'zod';
import { MAIN_CONFIG } from './config';
import { getSolutionNamespace } from './node-red/red';
import { retryHttpAsyncCall, submitSolutionResult } from './polkadot/polka';
import { createEwxTxManager, createLogger, sleep } from './util';

interface VoteTask {
  votingRoundId: string;
  noderedId: string;
  vote: string;
  startedAt: number;
  solutionNamespace: string;
  voteIdentifier: string | null;
  hashVote: boolean;
}

const SUBMIT_VOTE_SCHEMA = z
  .object({
    id: z.string(),
    noderedId: z.string(),
    root: z.string(),
    hashVote: z.boolean().optional().default(true),
  })
  .refine(
    (data) => {
      if (!data.hashVote) {
        return Buffer.byteLength(data.root, 'utf8') <= 32;
      }
      return true;
    },
    {
      message: 'if not hashing the vote it must be no longer than 32 bytes',
      path: ['root'],
    },
  );

const queue: queueAsPromised<VoteTask> = fastq.promise(asyncWorker, 4);

const ewxTxManager = createEwxTxManager();

const DELAY_TIMER: number = 30 * 1000;
const NINE_MINUTES = 540000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const voteQueueLogger = createLogger('VoteQueue');

const voteStorage: Map<string, { transactionHash: string | null; createdAt: number }> = new Map<
  string,
  { transactionHash: string | null; createdAt: number }
>();

queue.error((error: Error | null, task: VoteTask) => {
  if (error == null) {
    return;
  }

  voteQueueLogger.error({ task }, 'unexpected vote queue error');
  voteQueueLogger.error(error);
});

setInterval(() => {
  const current = Date.now();

  voteStorage.forEach(({ createdAt }, key) => {
    if (createdAt + ONE_DAY_MS <= current) {
      voteStorage.delete(key);
    }
  });
}, 5000);

export const createVoteRouter = (): express.Router => {
  const voteRouter = express.Router({ mergeParams: true });

  voteRouter.get('/queue-info', (_, res) => {
    res.json({
      pendingTasks: queue.length(),
      isIdle: queue.idle(),
      runningTasks: queue.running(),
    });
  });

  voteRouter.get('/sse/:id', (req, res) => {
    if (req.query?.voteIdentifier == null) {
      res.status(200).json({
        hash: null,
      });

      return;
    }

    res.status(200).json({
      hash: voteStorage.get(req.query.voteIdentifier as string) ?? null,
    });
  });

  voteRouter.post(
    '/sse/:id',
    asyncHandler(async (req, res) => {
      const { hashVote, id, noderedId, root } = SUBMIT_VOTE_SCHEMA.parse(req.body);

      const solutionNamespace: string | null = await getSolutionNamespace(noderedId);

      if (solutionNamespace == null) {
        voteQueueLogger.error({ solutionNamespace }, 'solution is not present in nodered');

        res.status(204).json();

        return;
      }

      const payload = {
        votingRoundId: id,
        noderedId,
        vote: root,
        solutionNamespace,
        hashVote,
      };

      try {
        voteQueueLogger.info({ payload }, 'sending vote to queue');

        res.status(204).json();

        await queue.push({
          startedAt: Date.now(),
          voteIdentifier: (req.query.voteIdentifier as string) ?? null,
          ...payload,
        });
      } catch (e) {
        voteQueueLogger.error(payload, 'failed to submit vote');

        voteQueueLogger.error(e);

        res.status(204).json();
      }
    }),
  );

  return voteRouter;
};

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
      await queue.push(arg);
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
    .then((hash) => {
      if (task.voteIdentifier != null) {
        voteStorage.set(task.voteIdentifier, {
          createdAt: Date.now(),
          transactionHash: hash,
        });
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
