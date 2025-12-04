import { MAIN_CONFIG } from '../config';
import pino, { type Logger, type LoggerOptions } from 'pino';

export const createLogger = (options: string | LoggerOptions): Logger => {
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
    return pino(prettyTransport);
  }

  return pino({
    ...(typeof options === 'string' ? { name: options } : options),
  });
};
