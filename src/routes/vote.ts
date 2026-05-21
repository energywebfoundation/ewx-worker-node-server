import express from 'express';
import { z } from 'zod';
import asyncHandler from 'express-async-handler';
import { VOTE_STORAGE, voteQueue, voteQueueLogger } from '../polkadot/vote';
import { ALL_RUNTIMES } from '../runtime/registry';
import { type SolutionIdentifier } from '../runtime/runtime';

/**
 * Accept either:
 *   - noderedId + root + id      (legacy NR flows)
 *   - solutionId + root + id     (new n8n flows, or NR flows that prefer this)
 *
 * solutionId takes precedence if both are sent, because it is the canonical
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
const resolveSolutionNamespace = async (identifier: SolutionIdentifier): Promise<string | null> => {
  if (identifier.kind === 'solutionId') {
    // chain-level namespace is the value itself; verify some runtime has it
    // installed so stale votes get dropped.
    for (const rt of ALL_RUNTIMES) {
      const installed: string[] = await rt.getAllInstalledSolutionsNames();

      if (installed.includes(identifier.value)) {
        return identifier.value;
      }
    }

    return null;
  }

  // kind === 'noderedId'
  for (const rt of ALL_RUNTIMES) {
    const ns: string | null = await rt.getSolutionNamespace(identifier.value);

    if (ns != null) return ns;
  }

  return null;
};

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
      const { hashVote, id, noderedId, solutionId, root } = SUBMIT_VOTE_SCHEMA.parse(req.body);

      // solutionId takes precedence when both are provided. The schema's
      // refine() guarantees at least one of noderedId/solutionId is set.
      let identifier: SolutionIdentifier;
      if (solutionId != null) {
        identifier = { kind: 'solutionId', value: solutionId };
      } else if (noderedId != null) {
        identifier = { kind: 'noderedId', value: noderedId };
      } else {
        // Unreachable: zod refine() rejects bodies missing both fields,
        // but TypeScript can't see that through the schema.
        res.status(400).json({ error: 'vote must include noderedId or solutionId' });
        return;
      }

      const solutionNamespace: string | null = await resolveSolutionNamespace(identifier);

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
