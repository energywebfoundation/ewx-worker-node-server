import express from 'express';
import { MAIN_CONFIG } from './config';
import { createKeyringPair } from './account';
import { ALL_RUNTIMES } from './runtime/registry';
import { type SolutionIdentifier } from './runtime/runtime';
import asyncHandler from 'express-async-handler';

/**
 * Resolve solutionNamespace + solutionGroupId from whichever identifier the
 * caller has. The discriminated SolutionIdentifier makes intent explicit at
 * the call site.
 *
 * - kind === 'noderedId': ask each runtime to translate its internal id into
 *   the logical parts. Used by legacy NR callers that pass a tab id.
 * - kind === 'solutionId': look up the installed handle with that solutionId
 *   across runtimes and derive parts from it.
 */
const resolveSolutionDetails = async (
  identifier: SolutionIdentifier,
): Promise<{ solutionNamespace: string; solutionGroupId: string } | null> => {
  if (identifier.kind === 'noderedId') {
    for (const rt of ALL_RUNTIMES) {
      const parts = await rt.getSolutionLogicalParts(identifier.value);

      if (parts != null) return parts;
    }

    return null;
  }

  for (const rt of ALL_RUNTIMES) {
    const handles = await rt.getInstalledSolutionHandles();
    const handle = handles.find((h) => h.solutionId === identifier.value);

    if (handle?.solutionGroupId != null) {
      return {
        solutionNamespace: identifier.value,
        solutionGroupId: handle.solutionGroupId,
      };
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

      const nodeRedId: string | undefined = req.query.nodeRedId as string | undefined;
      const solutionId: string | undefined = req.query.solutionId as string | undefined;

      let solutionDetails: {
        solutionNamespace: string;
        solutionGroupId: string;
      } | null = null;

      if (solutionId != null) {
        solutionDetails = await resolveSolutionDetails({
          kind: 'solutionId',
          value: solutionId,
        });
      } else if (nodeRedId != null) {
        solutionDetails = await resolveSolutionDetails({
          kind: 'noderedId',
          value: nodeRedId,
        });
      }

      res.status(200).json({
        rpcUrl: MAIN_CONFIG.PALLET_RPC_URL,
        workerAddress: account.address,
        solutionDetails,
      });
    }),
  );

  return router;
};
