import { createLogger } from './logger';

export enum APP_BOOTSTRAP_STATUS {
  STARTED = 'STARTED',
  EXPOSED_HTTP = 'EXPOSED_HTTP',
  INITIALIZED_WORKER_ACCOUNT = 'INITIALIZED_WORKER_ACCOUNT',
  PERFORMED_CHECKS = 'PERFORMED_CHECKS',
  STARTED_RED_SERVER = 'STARTED_RED_SERVER',
  READY = 'READY',
}

const statusLogger = createLogger('AppBootstrapStatus');

let APP_STATE: APP_BOOTSTRAP_STATUS = APP_BOOTSTRAP_STATUS.STARTED;

export const getAppState = (): APP_BOOTSTRAP_STATUS => APP_STATE;

export const setAppState = (state: APP_BOOTSTRAP_STATUS): void => {
  statusLogger.info(
    {
      oldStatus: APP_STATE,
      newStatus: state,
    },
    'changing app bootstrap status',
  );

  APP_STATE = state;
};
