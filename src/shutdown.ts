import type * as http from 'http';
import { createLogger } from './util/logger';
import { MAIN_CONFIG } from './config';
import * as RED from 'node-red';
import { drainVoteQueue } from './polkadot/vote';

const logger = createLogger('Shutdown');

// Store references to resources that need cleanup
let mainServer: http.Server | null = null;
let nodeRedServer: http.Server | null = null;

let isShuttingDown = false;

export const getIsShuttingDown = (): boolean => {
  return isShuttingDown;
};

// Setter functions to register resources
export const setMainServer = (server: http.Server): void => {
  mainServer = server;
};

export const setNodeRedServer = (server: http.Server): void => {
  nodeRedServer = server;
};

// Main shutdown function
export const gracefulShutdown = async (
  timeoutMs: number = MAIN_CONFIG.SHUTDOWN_TIMEOUT_MS,
): Promise<void> => {
  // 1. Idempotency check
  if (isShuttingDown) {
    logger.warn('shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('initiating graceful shutdown');

  // 2. Set exit code early to allow graceful completion
  process.exitCode = 0;

  // 3. Set up timeout protection
  const shutdownTimeout = setTimeout(() => {
    logger.error('graceful shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, timeoutMs);

  try {
    // 4. Cleanup sequence

    // Drain vote queue (wait for pending votes to complete)
    await drainVoteQueue();
    logger.info('vote queue drained');

    // Stop Node-RED runtime
    try {
      await RED.stop();
      logger.info('Node-RED runtime stopped');
    } catch (error) {
      logger.error({ error }, 'error stopping Node-RED runtime');
    }

    // Close HTTP servers (stop accepting new connections)
    if (nodeRedServer != null) {
      try {
        await new Promise<void>((resolve) => {
          nodeRedServer?.close(() => {
            logger.info('Node-RED HTTP server closed');
            resolve();
          });
          nodeRedServer?.closeIdleConnections();
        });
      } catch (error) {
        logger.error({ error }, 'error closing Node-RED server');
      }
    }

    if (mainServer != null) {
      try {
        await new Promise<void>((resolve) => {
          mainServer?.close(() => {
            logger.info('main HTTP server closed');
            resolve();
          });
          mainServer?.closeIdleConnections();
        });
      } catch (error) {
        logger.error({ error }, 'error closing main server');
      }
    }

    // 5. Clear timeout and complete
    clearTimeout(shutdownTimeout);
    logger.info('graceful shutdown completed');
  } catch (error) {
    // 6. Error handling
    clearTimeout(shutdownTimeout);
    logger.error({ error }, 'error during graceful shutdown');
    process.exitCode = 1;
    throw error;
  }
};

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, initiating graceful shutdown');
  void gracefulShutdown().then(() => {
    process.exit(process.exitCode ?? 0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, initiating graceful shutdown');
  void gracefulShutdown().then(() => {
    process.exit(process.exitCode ?? 0);
  });
});
