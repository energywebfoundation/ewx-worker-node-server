import express from 'express';
import asyncHandler from 'express-async-handler';
import { createKeyringPair } from '../polkadot/account';
import { getBaseUrls } from '../util/base-urls';
import { AppVersion } from '../util/version';
import { MAIN_CONFIG } from '../config';
import { ALL_RUNTIMES } from '../runtime/registry';
import { type SolutionIdentifier } from '../runtime/runtime';

/**
 * Resolve solutionNamespace + solutionGroupId from whatever identifier the
 * caller has: legacy NR callers pass nodeRedId (the tab id), n8n callers pass
 * solutionId. Either works here.
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

  // kind === 'solutionId'
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
      const baseUrls = await getBaseUrls();

      const nodeRedId = req.query.nodeRedId as string | undefined;
      const solutionId = req.query.solutionId as string | undefined;

      let solutionDetails: { solutionNamespace: string; solutionGroupId: string } | null = null;

      if (nodeRedId != null) {
        solutionDetails = await resolveSolutionDetails({
          kind: 'noderedId',
          value: nodeRedId,
        });
      } else if (solutionId != null) {
        solutionDetails = await resolveSolutionDetails({
          kind: 'solutionId',
          value: solutionId,
        });
      }

      res.status(200).json({
        rpcUrl: baseUrls.rpcUrl,
        workerAddress: account.address,
        appVersion: AppVersion,
        solutionDetails,
        baseUrlsSource: MAIN_CONFIG.BASE_URLS,
        baseUrls,
      });
    }),
  );

  return router;
};
