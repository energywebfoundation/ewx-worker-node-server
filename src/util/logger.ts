import { MAIN_CONFIG } from '../config';
import pino, { type Logger, type LoggerOptions } from 'pino';
import * as path from 'path';
import * as fs from 'fs';
import hash from 'object-hash';

const transportCache = new Map<string, ReturnType<typeof pino.transport>>();

const normalizeLogPath = (logPath: string): string => {
  if (logPath.endsWith('/') || logPath.endsWith('\\')) {
    return path.join(logPath, 'app.log');
  }
  if (path.extname(logPath).length === 0) {
    return `${logPath}.log`;
  }
  return logPath;
};

const ensureLogDirExists = (logPath: string): void => {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const getFileTransport = (
  logPath: string,
  retentionDays?: number,
): ReturnType<typeof pino.transport> => {
  const normalizedPath = normalizeLogPath(logPath);
  ensureLogDirExists(normalizedPath);

  const parsed = path.parse(normalizedPath);
  const options = {
    file: path.join(parsed.dir, parsed.name),
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    mkdir: true,
    extension: parsed.ext,
    stream: {
      highWaterMark: 1024 * 1024 * 2, // 2MB memory buffer
      autoDestroy: true,
      emitClose: true,
    },
    ...(retentionDays != null && retentionDays > 0
      ? {
          limit: {
            count: retentionDays,
            removeOtherLogFiles: true,
          },
        }
      : {}),
  };

  const cacheKey = `file:${hash(options)}`;
  const cached = transportCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }

  const transport = pino.transport({
    target: 'pino-roll',
    options,
  });
  transportCache.set(cacheKey, transport);
  return transport;
};

const getPrettyTransport = (): ReturnType<typeof pino.transport> => {
  const options = {
    colorize: true,
    levelFirst: true,
    translateTime: 'SYS:HH:MM:ss',
  };

  const cacheKey = `pretty:${hash(options)}`;
  const cached = transportCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }

  const transport = pino.transport({
    target: 'pino-pretty',
    options,
  });
  transportCache.set(cacheKey, transport);
  return transport;
};

export const createLogger = (options: string | LoggerOptions): Logger => {
  const loggerOptions = typeof options === 'string' ? { name: options } : options;
  const level = loggerOptions.level ?? 'info';

  const { LOG_FILE_PATH, PRETTY_PRINT, LOG_RETENTION_DAYS } = MAIN_CONFIG;
  const hasFile = Boolean(LOG_FILE_PATH?.trim());
  const hasPretty = Boolean(PRETTY_PRINT);

  // No transports: simple console logger
  if (!hasFile && !hasPretty) {
    return pino({ ...loggerOptions, level });
  }

  // Both file and pretty
  if (hasFile && hasPretty && LOG_FILE_PATH != null) {
    const fileTransport = getFileTransport(LOG_FILE_PATH, LOG_RETENTION_DAYS);
    const prettyTransport = getPrettyTransport();
    return pino(
      { ...loggerOptions, level },
      pino.multistream([
        { level, stream: fileTransport },
        { level, stream: prettyTransport },
      ]),
    );
  }

  // File only
  if (hasFile && LOG_FILE_PATH != null) {
    const fileTransport = getFileTransport(LOG_FILE_PATH, LOG_RETENTION_DAYS);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return pino({ ...loggerOptions, level }, fileTransport);
  }

  // Pretty only
  const prettyTransport = getPrettyTransport();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return pino({ ...loggerOptions, level }, prettyTransport);
};
