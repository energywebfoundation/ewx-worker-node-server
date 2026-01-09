import { type ApiPromise } from '@polkadot/api';
import pino, { type Logger, type LoggerOptions } from 'pino';
import pretty from 'pino-pretty';
import * as fs from 'fs';
import * as path from 'path';
import { MAIN_CONFIG } from './config';
import type { EwxTxManager } from './ewx-tx-manager';
import { EwxHttpTxManager } from './ewx-tx-manager-http';
import { createApi, retryHttpAsyncCall } from './polkadot/polka';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const invertObject = (obj: Record<string, any>) => {
  if (obj == null) {
    throw new Error('obj is null');
  }

  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [value, key]));
};

export const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const createReadPalletApi = async (): Promise<ApiPromise> => {
  const palletRpcUrl: string = MAIN_CONFIG.PALLET_RPC_URL;

  return await retryHttpAsyncCall(async () => await createApi(palletRpcUrl));
};

export const createWritePalletApi = async (): Promise<ApiPromise> => {
  const votingRpcUrl: string = MAIN_CONFIG.VOTING_RPC_URL;

  return await retryHttpAsyncCall(async () => await createApi(votingRpcUrl));
};

export const createEwxTxManager = (): EwxTxManager => {
  return new EwxHttpTxManager(new URL(MAIN_CONFIG.VOTING_RPC_URL));
};

export const createLogger = (options: string | LoggerOptions): Logger => {
  const loggerOptions = typeof options === 'string' ? { name: options } : options;
  let logFilePath = MAIN_CONFIG.LOG_FILE_PATH;
  const defaultLevel = loggerOptions.level ?? 'info';

  // If log file path is configured, normalize it and ensure directory exists
  if (logFilePath != null) {
    // If path ends with / or \ (directory), append default filename
    if (logFilePath.endsWith('/') || logFilePath.endsWith('\\')) {
      logFilePath = path.join(logFilePath, 'app.log');
    }
    // If path has no extension, add .log extension
    else if (path.extname(logFilePath) === '') {
      logFilePath = `${logFilePath}.log`;
    }

    // Ensure directory exists
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  // If both file logging and pretty print are enabled, use multi-stream
  if (logFilePath != null && MAIN_CONFIG.PRETTY_PRINT) {
    // Extract base filename and extension for pino-roll
    // pino-roll format: filename.date.count.extension
    // To avoid double extension (test.log.2025-12-10.1.log), we need to separate base name and extension
    const parsedPath = path.parse(logFilePath);
    const baseFileName = parsedPath.name; // filename without extension
    const extension = parsedPath.ext !== '' ? parsedPath.ext : '.log'; // extension or default to .log

    // Create pino-roll transport for daily rotation with date-based filenames
    const pinoRollOptions: {
      file: string;
      frequency: string;
      dateFormat: string;
      mkdir: boolean;
      extension: string;
      limit?: { count: number; removeOtherLogFiles?: boolean };
    } = {
      file: path.join(parsedPath.dir, baseFileName), // Base filename without extension
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      extension, // Extension to append
    };

    // Add retention policy if configured
    // limit.count keeps N rotated files (plus 1 active = N+1 days total)
    // For daily rotation: count = retentionDays keeps retentionDays of old logs + current day
    if (MAIN_CONFIG.LOG_RETENTION_DAYS != null) {
      pinoRollOptions.limit = {
        count: MAIN_CONFIG.LOG_RETENTION_DAYS,
        removeOtherLogFiles: true, // Clean up old files even from previous runs
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const fileTransport = pino.transport({
      target: 'pino-roll',
      options: pinoRollOptions,
    }); // pino.transport returns a stream compatible with multistream

    const streams = [
      // File stream (JSON format) - using pino-roll for automatic daily rotation
      {
        level: defaultLevel,
        stream: fileTransport,
      },
      // Console stream (pretty format)
      {
        level: defaultLevel,
        stream: pretty({
          colorize: true,
          levelFirst: true,
          translateTime: 'SYS:HH:MM:ss',
        }),
      },
    ];

    // Main logger level MUST be set to the lowest level in multistream
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return pino({ ...loggerOptions, level: defaultLevel }, pino.multistream(streams));
  }

  // If only file logging is enabled
  if (logFilePath != null) {
    // Extract base filename and extension for pino-roll
    // pino-roll format: filename.date.count.extension
    // To avoid double extension (test.log.2025-12-10.1.log), we need to separate base name and extension
    const parsedPath = path.parse(logFilePath);
    const baseFileName = parsedPath.name; // filename without extension
    const extension = parsedPath.ext !== '' ? parsedPath.ext : '.log'; // extension or default to .log

    // Use pino-roll transport for automatic daily rotation with date-based filenames
    const pinoRollOptions: {
      file: string;
      frequency: string;
      dateFormat: string;
      mkdir: boolean;
      extension: string;
      limit?: { count: number; removeOtherLogFiles?: boolean };
    } = {
      file: path.join(parsedPath.dir, baseFileName), // Base filename without extension
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      extension, // Extension to append
    };

    // Add retention policy if configured
    // limit.count keeps N rotated files (plus 1 active = N+1 days total)
    // For daily rotation: count = retentionDays keeps retentionDays of old logs + current day
    if (MAIN_CONFIG.LOG_RETENTION_DAYS != null) {
      pinoRollOptions.limit = {
        count: MAIN_CONFIG.LOG_RETENTION_DAYS,
        removeOtherLogFiles: true, // Clean up old files even from previous runs
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const fileTransport = pino.transport({
      target: 'pino-roll',
      options: pinoRollOptions,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return pino(loggerOptions, fileTransport);
  }

  // If only pretty print is enabled (original behavior)
  if (MAIN_CONFIG.PRETTY_PRINT) {
    const prettyTransport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        levelFirst: true,
        translateTime: 'SYS:HH:MM:ss',
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return pino(loggerOptions, prettyTransport);
  }

  // Default: console only (JSON format)
  return pino(loggerOptions);
};
