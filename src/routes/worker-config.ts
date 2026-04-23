import express from 'express';
import asyncHandler from 'express-async-handler';
import { createKeyringPair } from '../polkadot/account';
import { getBaseUrls } from '../util/base-urls';
import { getSolutionLogicalParts } from '../node-red/red';
import { AppVersion } from '../util/version';
import { MAIN_CONFIG } from '../config';

export const createConfigRouter = (): express.Router => {
  const router = express.Router({
    mergeParams: true,
  });

  router.get(
    '/config',
    asyncHandler(async (req, res) => {
      const account = createKeyringPair();
      const baseUrls = await getBaseUrls();

      const solutionDetails: {
        solutionNamespace: string;
        solutionGroupId: string;
      } | null =
        req.query.nodeRedId != null
          ? await getSolutionLogicalParts(req.query.nodeRedId as string)
          : null;

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
