import type * as http from 'http';
import { createLogger } from './util';
import * as RED from 'node-red';

const logger = createLogger('Shutdown');

// Store references to resources that need cleanup
let mainServer: http.Server | null = null;
let nodeRedServer: http.Server | null = null;

let isShuttingDown = false;

export const setMainServer = (server: http.Server): void => {
  mainServer = server;
};

export const setNodeRedServer = (server: http.Server): void => {
  nodeRedServer = server;
};

export const gracefulShutdown = async (timeoutMs: number = 30000): Promise<void> => {
  if (isShuttingDown) {
    logger.warn('shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('initiating graceful shutdown');

  // Set exit code early to allow graceful completion
  process.exitCode = 0;

  const shutdownTimeout = setTimeout(() => {
    logger.error('graceful shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, timeoutMs);

  try {
    // Stop Node-RED runtime
    try {
      await RED.stop();
      logger.info('Node-RED runtime stopped');
    } catch (error) {
      logger.error({ error }, 'error stopping Node-RED runtime');
    }

    // Close Node-RED HTTP server
    if (nodeRedServer != null) {
      await new Promise<void>((resolve) => {
        nodeRedServer?.close(() => {
          logger.info('Node-RED HTTP server closed');
          resolve();
        });
        nodeRedServer?.closeIdleConnections();
      });
    }

    // Close main HTTP server
    if (mainServer != null) {
      await new Promise<void>((resolve) => {
        mainServer?.close(() => {
          logger.info('main HTTP server closed');
          resolve();
        });
        mainServer?.closeIdleConnections();
      });
    }

    clearTimeout(shutdownTimeout);
    logger.info('graceful shutdown completed');
  } catch (error) {
    clearTimeout(shutdownTimeout);
    logger.error({ error }, 'error during graceful shutdown');
    process.exitCode = 1;
    throw error;
  }
};
