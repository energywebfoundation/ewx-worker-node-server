import express from 'express';
import { z } from 'zod';
import asyncHandler from 'express-async-handler';
import { getSolutionNamespace } from '../node-red/red';
import { VOTE_STORAGE, voteQueue, voteQueueLogger } from '../polkadot/vote';

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

export const createVoteRouter = (): express.Router => {
  const voteRouter = express.Router({ mergeParams: true });

  voteRouter.get('/queue-info', (_, res) => {
    res.json({
      pendingTasks: voteQueue.length(),
      isIdle: voteQueue.idle(),
      runningTasks: voteQueue.running(),
    });
  });

  voteRouter.get('/sse/:id', (req, res) => {
    if (req.query?.voteIdentifier == null) {
      res.status(200).json({
        hash: null,
      });

      return;
    }

    void VOTE_STORAGE.get(req.query.voteIdentifier as string).then((hash) => {
      res.status(200).json({
        hash,
      });
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

        await voteQueue.push({
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
