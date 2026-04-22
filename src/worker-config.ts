import express from 'express';
import { MAIN_CONFIG } from './config';
import { createKeyringPair } from './account';
import { ALL_RUNTIMES } from './runtime/registry';
import asyncHandler from 'express-async-handler';

/**
 * Resolve solutionNamespace + solutionGroupId from whatever identifier the
 * caller has: legacy NR callers pass nodeRedId (the tab id), n8n callers pass
 * solutionId. Either works here.
 */
const resolveSolutionDetails = async (
  nodeRedId: string | undefined,
  solutionId: string | undefined,
): Promise<{ solutionNamespace: string; solutionGroupId: string } | null> => {
  if (nodeRedId != null) {
    for (const rt of ALL_RUNTIMES) {
      const parts = await rt.getSolutionLogicalParts(nodeRedId);

      if (parts != null) return parts;
    }
  }

  if (solutionId != null) {
    for (const rt of ALL_RUNTIMES) {
      const handles = await rt.getInstalledSolutionHandles();
      const handle = handles.find((h) => h.solutionId === solutionId);

      if (handle?.solutionGroupId != null) {
        return {
          solutionNamespace: solutionId,
          solutionGroupId: handle.solutionGroupId,
        };
      }
    }
  }

  return null;
};

export const createConfigRouter = (): express.Router => {
  const router = express.Router({
    mergeParams: true,
  });

  router.get(
    '/config',
    asyncHandler(async (req, res) => {
      const account = createKeyringPair();

      const solutionDetails: {
        solutionNamespace: string;
        solutionGroupId: string;
      } | null = await resolveSolutionDetails(
        req.query.nodeRedId as string | undefined,
        req.query.solutionId as string | undefined,
      );

      res.status(200).json({
        rpcUrl: MAIN_CONFIG.PALLET_RPC_URL,
        workerAddress: account.address,
        solutionDetails,
      });
    }),
  );

  return router;
};
