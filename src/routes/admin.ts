import express from 'express';
import { createLogger } from '../util/logger';
import { getIsShuttingDown } from '../shutdown';
import asyncHandler from 'express-async-handler';
import { MAIN_CONFIG } from '../config';

const adminLogger = createLogger('Admin');

/**
 * Middleware to authenticate admin requests using API key
 */
const authenticateAdmin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  // If ADMIN_API_KEY is not configured, skip authentication
  if (MAIN_CONFIG.ADMIN_API_KEY == null) {
    next();
    return;
  }

  const apiKey = req.headers['x-api-key'];
  const apiKeyString = typeof apiKey === 'string' ? apiKey : null;

  if (apiKeyString == null || apiKeyString !== MAIN_CONFIG.ADMIN_API_KEY) {
    adminLogger.warn(
      {
        ip: req.ip,
        path: req.path,
      },
      'unauthorized admin access attempt',
    );
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid or missing API key',
    });
    return;
  }

  next();
};

export const createAdminRouter = (): express.Router => {
  const adminRouter: express.Router = express.Router({ mergeParams: true });

  // Apply authentication middleware if API key is configured
  adminRouter.use(authenticateAdmin);

  adminRouter.post(
    '/stop',
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
