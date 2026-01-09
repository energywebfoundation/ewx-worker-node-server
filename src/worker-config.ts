import express from 'express';
import { MAIN_CONFIG } from './config';
import { createKeyringPair } from './account';
import { getSolutionLogicalParts } from './node-red/red';
import asyncHandler from 'express-async-handler';
import { gracefulShutdown } from './shutdown';
import { createLogger } from './util';

const logger = createLogger('WorkerConfig');

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
      } | null =
        req.query.nodeRedId != null
          ? await getSolutionLogicalParts(req.query.nodeRedId as string)
          : null;

      res.status(200).json({
        rpcUrl: MAIN_CONFIG.PALLET_RPC_URL,
        workerAddress: account.address,
        solutionDetails,
      });
    }),
  );

  router.post(
    '/admin/stop',
    asyncHandler(async (req, res) => {
      try {
        logger.info('received shutdown request via /admin/stop endpoint');

        // Send response immediately before shutdown
        res.status(200).json({
          success: true,
          message: 'Graceful shutdown initiated',
        });

        // Perform graceful shutdown after response is sent
        // Use setTimeout to ensure response is sent first
        setTimeout(() => {
          void (async () => {
            try {
              await gracefulShutdown();
              // process.exitCode is already set in gracefulShutdown
              process.exit(process.exitCode ?? 0);
            } catch (error) {
              logger.error({ error }, 'error during shutdown');
              process.exitCode = 1;
              process.exit(1);
            }
          })();
        }, 100);
      } catch (error) {
        logger.error({ error }, 'error initiating shutdown');
        res.status(500).json({
          success: false,
          message: 'Failed to initiate shutdown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return router;
};
