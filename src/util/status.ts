import express from 'express';
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

export const createStatusRouter = (): express.Router => {
  const statusRouter = express.Router({ mergeParams: true });

  statusRouter.get('/status', (_, res) => {
    res.status(200).json({
      status: APP_STATE,
    });
  });

  return statusRouter;
};
