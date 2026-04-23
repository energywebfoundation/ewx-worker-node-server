import { writeFileSync } from 'fs';
import { runtimeStarted } from '../node-red/red';
import { createLogger } from '../util/logger';
import { MAIN_CONFIG } from '../config';

const logger = createLogger('Heartbeat');

export const startHeartbeat = (): void => {
  setInterval(() => {
    try {
      runtimeStarted()
        .then((status) => {
          if (status) {
            writeFileSync(MAIN_CONFIG.HEARTBEAT_PATH, Date.now().toString(), 'utf8');

            return;
          }

          logger.warn('RED runtime is not working');
        })
        .catch((e) => {
          logger.error(`failed to get red runtime`);
          logger.error(e);
        });

      logger.info('writing heartbeat');
    } catch (error) {
      logger.error('failed to write heartbeat');
      logger.error(error);
    }
  }, MAIN_CONFIG.HEARTBEAT_INTERVAL);
};
