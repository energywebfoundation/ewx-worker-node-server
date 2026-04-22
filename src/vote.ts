import { Keyring } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
import express from 'express';
import asyncHandler from 'express-async-handler';
import type { queueAsPromised } from 'fastq';
import * as fastq from 'fastq';
import { z } from 'zod';
import { MAIN_CONFIG } from './config';
import { ALL_RUNTIMES } from './runtime/registry';
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

/**
 * Accept either:
 *   - noderedId + root + id      (legacy NR flows)
 *   - solutionId + root + id     (new n8n flows, or NR flows that prefer this)
 *
 * solutionId takes precedence if both are sent, because it's the canonical
 * chain-level identifier. noderedId is resolved via the runtime registry so
 * the lookup works regardless of which runtime submitted the vote.
 */
const SUBMIT_VOTE_SCHEMA = z
  .object({
    id: z.string(),
    noderedId: z.string().optional(),
    solutionId: z.string().optional(),
    root: z.string(),
    hashVote: z.boolean().optional().default(true),
  })
  .refine((data) => data.noderedId != null || data.solutionId != null, {
    message: 'vote must include either noderedId or solutionId',
    path: ['solutionId'],
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

/**
 * Resolve a vote's solution namespace across every registered runtime. For NR
 * votes the body contains noderedId; for n8n votes it contains solutionId
 * directly. Returns null if the identifier matches nothing known.
 */
const resolveSolutionNamespace = async (
  noderedId: string | undefined,
  solutionId: string | undefined,
): Promise<string | null> => {
  // solutionId path: chain-level namespace is the value itself; we just need
  // to verify that some runtime has it installed so stale votes get dropped.
  if (solutionId != null) {
    for (const rt of ALL_RUNTIMES) {
      const installed: string[] = await rt.getAllInstalledSolutionsNames();

      if (installed.includes(solutionId)) {
        return solutionId;
      }
    }

    return null;
  }

  if (noderedId == null) return null;

  for (const rt of ALL_RUNTIMES) {
    const ns: string | null = await rt.getSolutionNamespace(noderedId);

    if (ns != null) return ns;
  }

  return null;
};

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
      const parsed = SUBMIT_VOTE_SCHEMA.parse(req.body);
      const { hashVote, id, noderedId, solutionId, root } = parsed;

      const solutionNamespace: string | null = await resolveSolutionNamespace(
        noderedId,
        solutionId,
      );

      if (solutionNamespace == null) {
        voteQueueLogger.error({ noderedId, solutionId }, 'vote target not found in any runtime');

        res.status(204).json();

        return;
      }

      const payload = {
        votingRoundId: id,
        // noderedId kept in the task type for log compatibility; when the
        // caller sends solutionId instead, we fill in a synthetic value so
        // downstream code still has something to put in logs.
        noderedId: noderedId ?? `n8n:${solutionNamespace}`,
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
