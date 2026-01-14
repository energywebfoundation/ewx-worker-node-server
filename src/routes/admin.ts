import express from 'express';
import { createLogger } from '../util/logger';
import { getIsShuttingDown } from '../shutdown';
import asyncHandler from 'express-async-handler';

const adminLogger = createLogger('Admin');

export const createAdminRouter = (): express.Router => {
  const adminRouter: express.Router = express.Router({ mergeParams: true });

  adminRouter.post(
    '/admin/stop',
    asyncHandler(async (req, res) => {
      try {
        // Check if shutdown is already in progress
        if (getIsShuttingDown()) {
          adminLogger.warn('shutdown already in progress, ignoring duplicate request');
          res.status(200).json({
            success: true,
            message: 'Shutdown already in progress',
          });
          return;
        }

        adminLogger.info('received shutdown request via /admin/stop endpoint');

        // Send response immediately before shutdown
        res.status(200).json({
          success: true,
          message: 'Graceful shutdown initiated',
        });

        process.kill(process.pid, 'SIGTERM');
      } catch (error) {
        adminLogger.error({ error }, 'error initiating shutdown');
        res.status(500).json({
          success: false,
          message: 'Failed to initiate shutdown',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return adminRouter;
};
